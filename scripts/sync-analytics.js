// Pulls daily social metrics from Metricool (v2 analytics timelines API) and upserts them into
// Supabase social_metrics_daily (platform, metric, date, value). Rewritten Oct 2026: the old
// /api/stats/timeline/<DataStudio id> call returned a single zero point.
// Env: METRICOOL_API_TOKEN, METRICOOL_USER_ID, METRICOOL_BRAND_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const need = ['METRICOOL_API_TOKEN', 'METRICOOL_USER_ID', 'METRICOOL_BRAND_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) { console.error('Missing env vars: ' + missing.join(', ')); process.exit(1); }
const E = process.env;
const DAYS_BACK = 120;
const TZ = 'America/Vancouver';

// [platform, stored metric, [Metricool v2 metric names to try, first that works wins]]
const METRICS = [
  ['instagram', 'followers', ['followers']], ['instagram', 'reach', ['reach']], ['instagram', 'views', ['views']],
  ['instagram', 'interactions', ['postsInteractions']], ['instagram', 'posts', ['postsCount']],
  ['instagram', 'gained', ['followers_gained']], ['instagram', 'lost', ['followers_lost']],
  ['facebook', 'followers', ['pageFollows']], ['facebook', 'views', ['page_media_view']], ['facebook', 'impressions', ['pageImpressions']],
  ['facebook', 'interactions', ['postsInteractions']], ['facebook', 'posts', ['postsCount']],
  ['facebook', 'gained', ['page_daily_follows_unique', 'Follows']], ['facebook', 'lost', ['page_daily_unfollows_unique', 'Unfollows']],
  ['linkedin', 'followers', ['followers']], ['linkedin', 'net', ['delta_followers', 'deltaFollowers']],
  ['linkedin', 'reach', ['impressions', 'postsImpressions', 'accountPostImpressions', 'views']],
  ['linkedin', 'interactions', ['postsInteractions', 'interactions', 'accountPostInteractions']],
  ['linkedin', 'posts', ['postsCount', 'posts', 'accountPostCount']],
  ['youtube', 'followers', ['totalSubscribers']], ['youtube', 'views', ['views']], ['youtube', 'posts', ['totalVideos']],
  ['youtube', 'gained', ['subscribersGained']], ['youtube', 'lost', ['subscribersLost']],
];

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const yyyymmdd = (d) => iso(d).replace(/-/g, '');
const H = { 'X-Mc-Auth': E.METRICOOL_API_TOKEN, Accept: 'application/json' };

async function get(url) {
  const res = await fetch(url, { headers: H });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

// Find [date, value] pairs anywhere in a Metricool response, whatever its exact shape.
function extract(node, out = []) {
  if (Array.isArray(node)) {
    for (const r of node) {
      if (Array.isArray(r) && r.length >= 2 && (typeof r[0] === 'string' || typeof r[0] === 'number') && /^\d{8}$|^\d{4}-\d{2}-\d{2}|^\d{10,13}$/.test(String(r[0])) && !isNaN(Number(r[1]))) out.push([r[0], r[1]]);
      else if (Array.isArray(r) && r.length >= 2 && /^\d{8}$/.test(String(r[r.length - 1])) && !isNaN(Number(r[0]))) out.push([r[r.length - 1], r[0]]);
      else if (r && typeof r === 'object' && !Array.isArray(r)) {
        const d = r.dateTime ?? r.date ?? r.day ?? r.timestamp ?? r.x;
        const v = r.value ?? r.count ?? r.total ?? r.y;
        if (d != null && v != null && v !== '' && !isNaN(Number(v))) out.push([d, v]);
        else extract(Object.values(r), out);
      } else extract(r, out);
    }
  } else if (node && typeof node === 'object') extract(Object.values(node), out);
  return out;
}
function normDate(d) {
  const s = String(d);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{10,13}$/.test(s)) return new Date(s.length === 10 ? s * 1000 : +s).toISOString().slice(0, 10);
  return s.slice(0, 10);
}

async function timeline(network, metric, from, to) {
  const base = `https://app.metricool.com/api/v2/analytics/timelines`;
  const q = new URLSearchParams({ blogId: E.METRICOOL_BRAND_ID, userId: E.METRICOOL_USER_ID, from: `${iso(from)}T00:00:00`, to: `${iso(to)}T23:59:59`, timezone: TZ, metric, subject: 'account', network });
  let r = await get(`${base}?${q}`);
  if (r.ok) return r;
  return r;
}

async function upsert(rows) {
  const key = E.SUPABASE_SERVICE_ROLE_KEY;
  const url = `${E.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/social_metrics_daily?on_conflict=platform,metric,date`;
  for (let i = 0; i < rows.length; i += 500) {
    const res = await fetch(url, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
}

(async () => {
  const now = new Date();
  const from = new Date(now.getTime() - DAYS_BACK * 864e5);
  const syncedAt = now.toISOString();
  const rows = [];
  let failures = 0;
  for (const [platform, metric, names] of METRICS) {
    let done = false;
    for (const name of names) {
      try {
        const r = await timeline(platform, name, from, now);
        if (!r.ok) { console.log(`  skip ${platform}/${metric} (${name}): HTTP ${r.status}`); continue; }
        let json; try { json = JSON.parse(r.body); } catch { console.log(`  skip ${platform}/${metric} (${name}): non-JSON`); continue; }
        const pts = extract(json);
        if (!pts.length) { console.log(`  skip ${platform}/${metric} (${name}): no points`); continue; }
        const byDate = pts.map((p) => [normDate(p[0]), Number(p[1])]).sort((x, y) => (x[0] < y[0] ? -1 : 1));
        console.log(`${platform}/${metric} (${name}): ${pts.length} points ${byDate[0][0]}..${byDate[byDate.length - 1][0]} latest=${JSON.stringify(byDate.slice(-3))}`);
        for (const [d, v] of byDate) rows.push({ platform, metric, metric_label: name, date: d, value: v, synced_at: syncedAt });
        done = true;
        break;
      } catch (e) { console.log(`  error ${platform}/${metric} (${name}): ${e.message}`); }
    }
    if (!done) { failures++; console.log(`FAIL ${platform}/${metric}: no working metric name`); }
  }
  // de-duplicate on the conflict key (a response can repeat a date)
  const seen = new Map();
  for (const r of rows) seen.set(`${r.platform}|${r.metric}|${r.date}`, r);
  const uniq = [...seen.values()];
  console.log(`Upserting ${uniq.length} rows (${failures} metric failures)`);
  if (uniq.length) await upsert(uniq);
  if (!uniq.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
