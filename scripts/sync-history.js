// Pulls Metricool's account history (followers, times seen, reactions, posts, followers gained/lost)
// for every month since January 2024 and writes data/history.json, which the yearly reports read.
// Only what Metricool actually has is kept: a metric starts counting on the first day Metricool has a
// real value for it, and months before that are left empty ("not in Metricool"), never filled with 0.
// Env: METRICOOL_API_TOKEN, METRICOOL_USER_ID, METRICOOL_BRAND_ID. Node 20, no dependencies.
const fs = require('fs');
const path = require('path');

const need = ['METRICOOL_API_TOKEN', 'METRICOOL_USER_ID', 'METRICOOL_BRAND_ID'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) { console.error('Missing env vars: ' + missing.join(', ')); process.exit(1); }
const E = process.env;
const TZ = 'America/Vancouver';
const FROM = new Date(Date.UTC(2024, 0, 1));
const CHUNK_DAYS = 180;
const OUT = path.join(__dirname, '..', 'data', 'history.json');
const H = { 'X-Mc-Auth': E.METRICOOL_API_TOKEN, Accept: 'application/json' };

// [channel, our key, how a month is totalled, Metricool metric names to try (first that returns data wins)]
// 'last' = the value on the last day of the month (followers), 'sum' = added up over the month
const METRICS = [
  ['ig', 'followers', 'last', ['followers']],
  ['ig', 'seen', 'sum', ['views']],
  ['ig', 'reach', 'sum', ['reach']],
  ['ig', 'posts', 'sum', ['postsCount']],
  ['ig', 'inter', 'sum', ['postsInteractions']],
  ['ig', 'gained', 'sum', ['followers_gained', 'followersGained']],
  ['ig', 'lost', 'sum', ['followers_lost', 'followersLost']],
  ['fb', 'followers', 'last', ['pageFollows', 'fbFollowers']],
  ['fb', 'seen', 'sum', ['page_media_view', 'pageMediaView']],
  ['fb', 'posts', 'sum', ['postsCount']],
  ['fb', 'inter', 'sum', ['postsInteractions']],
  ['fb', 'gained', 'sum', ['page_daily_follows_unique', 'followersAcquired', 'Follows']],
  ['fb', 'lost', 'sum', ['page_daily_unfollows_unique', 'followersLost', 'Unfollows']],
  ['fb', 'pageViews', 'sum', ['pageViews']],
  ['li', 'followers', 'last', ['followers']],
  ['li', 'net', 'sum', ['delta_followers', 'deltaFollowers']],
  ['li', 'seen', 'sum', ['accountPostImpressions', 'impressions', 'postsImpressions']],
  ['li', 'posts', 'sum', ['accountPostCount', 'postsCount', 'posts']],
  ['li', 'inter', 'sum', ['accountPostInteractions', 'postsInteractions', 'interactions']],
  ['li', 'clicks', 'sum', ['accountPostClicks', 'postsClicks']],
  ['yt', 'followers', 'last', ['totalSubscribers', 'subscribers']],
  ['yt', 'seen', 'sum', ['views', 'videoViews']],
  ['yt', 'posts', 'sum', ['totalVideos', 'videos']],
  ['yt', 'gained', 'sum', ['subscribersGained', 'gained']],
  ['yt', 'lost', 'sum', ['subscribersLost', 'lost']],
];
const NET = { ig: 'instagram', fb: 'facebook', li: 'linkedin', yt: 'youtube' };

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// [date, value] pairs anywhere in a Metricool response (same reader as sync-analytics.js)
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
  if (/^\d{8}/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{10,13}$/.test(s)) return new Date(s.length === 10 ? s * 1000 : +s).toISOString().slice(0, 10);
  return s.slice(0, 10);
}

async function timeline(network, metric, from, to) {
  const q = new URLSearchParams({ blogId: E.METRICOOL_BRAND_ID, userId: E.METRICOOL_USER_ID, from: `${ymd(from)}T00:00:00`, to: `${ymd(to)}T23:59:59`, timezone: TZ, metric, subject: 'account', network });
  const res = await fetch(`https://app.metricool.com/api/v2/analytics/timelines?${q}`, { headers: H });
  const body = await res.text();
  if (!res.ok) return { error: `HTTP ${res.status} ${body.slice(0, 160)}` };
  try { return { points: extract(JSON.parse(body)) }; } catch { return { error: 'non-JSON' }; }
}

// Daily points -> { since, months: { 'YYYY-MM': value } } using only days Metricool really tracked
function monthly(points, how) {
  const byDay = new Map();
  for (const [d, v] of points) { const x = Number(v); if (Number.isFinite(x)) byDay.set(normDate(d), x); }
  const days = [...byDay.keys()].sort();
  // tracking starts on the first day with a real (non-zero) value; zeros before that mean "not tracked yet"
  const first = days.find((d) => byDay.get(d) !== 0);
  if (!first) return { since: null, months: {} };
  const months = {};
  for (const d of days) {
    if (d < first) continue;
    const v = byDay.get(d); const m = d.slice(0, 7);
    if (how === 'last') { if (v > 0) months[m] = v; } // followers: last real count in the month
    else months[m] = (months[m] || 0) + v;
  }
  return { since: first, months };
}

(async () => {
  const to = new Date();
  const windows = [];
  for (let s = new Date(FROM); s <= to; ) { const e = new Date(Math.min(to.getTime(), s.getTime() + (CHUNK_DAYS - 1) * 864e5)); windows.push([new Date(s), e]); s = new Date(e.getTime() + 864e5); }
  const channels = {};
  let ok = 0, fail = 0;
  for (const [ch, key, how, names] of METRICS) {
    let done = false;
    for (const name of names) {
      const pts = []; let err = null;
      for (const [s, e] of windows) {
        const r = await timeline(NET[ch], name, s, e);
        if (r.error) { err = r.error; break; }
        pts.push(...r.points);
      }
      if (err) { console.log(`  skip ${ch}/${key} (${name}): ${err}`); continue; }
      const m = monthly(pts, how);
      if (!m.since) { console.log(`  ${ch}/${key} (${name}): no data`); continue; }
      (channels[ch] = channels[ch] || {})[key] = { metric: name, ...m };
      console.log(`${ch}/${key} (${name}): tracked since ${m.since}, ${Object.keys(m.months).length} months`);
      done = true; ok++; break;
    }
    if (!done) { fail++; console.log(`FAIL ${ch}/${key}: no working metric name`); }
  }
  if (!ok) { console.error('Nothing came back from Metricool; leaving data/history.json unchanged'); process.exit(1); }
  // keep last run's numbers for any metric that failed this time
  let prev = null; try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  // and never lose older months we already had (Metricool may return less history later): new numbers win,
  // months only in the old file are kept
  if (prev && prev.channels) for (const [ch, ms] of Object.entries(prev.channels)) for (const [k, v] of Object.entries(ms)) {
    const cur = channels[ch] && channels[ch][k];
    if (!cur) { (channels[ch] = channels[ch] || {})[k] = v; continue; }
    cur.months = Object.fromEntries(Object.entries({ ...(v.months || {}), ...cur.months }).sort());
    if (v.since && (!cur.since || v.since < cur.since)) cur.since = v.since;
  }
  if (prev && JSON.stringify(prev.channels) === JSON.stringify(channels)) { console.log('No change in history'); return; }
  fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), source: 'Metricool', from: '2024-01', channels }, null, 1) + '\n');
  console.log(`Wrote data/history.json (${ok} metrics ok, ${fail} failed)`);
})().catch((e) => { console.error(e); process.exit(1); });
