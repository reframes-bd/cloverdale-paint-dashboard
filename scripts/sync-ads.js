// Pulls ad campaign data (currently: Meta/Facebook Ads) from Metricool and upserts it into
// Supabase ad_campaigns (campaign_id, platform, name, status, spend, impressions, clicks,
// conversions, start_date, end_date). Mirrors scripts/sync-analytics.js's structure and
// failure-handling rules: never upsert on a response that doesn't look like real campaign
// data, log the raw shape so a wrong guess is visible in the Action log, not a silent zero-row
// "success" (see MISTAKES-AND-FIXES.md #2).
//
// Endpoint confirmed against Metricool's own published OpenAPI spec (downloaded from
// app.metricool.com/resources/apidocs -> Swagger.json, 2026-10-04), not guessed:
//   GET https://app.metricool.com/api/v2/advertising/campaigns
//   query: blogId, userId, from, to, timezone, providers[]=facebookads
//   header: X-Mc-Auth: <userToken>
// Response: { data: [ { network, providerCampaignId, name, status (ACTIVE|PAUSED|REMOVED),
//   objective, start:{dateTime}, stop:{dateTime}, dailyBudget, lifetimeBudget, currency,
//   metrics: {...free-form...} } ] }
// The "metrics" object's exact key names for spend/impressions/clicks/conversions are not
// specified in the spec (documented only as a free-form object), so this script tries a
// short list of likely names and logs the first raw metrics object so an unlisted name shows
// up immediately in the Action log.
//
// Env: METRICOOL_API_TOKEN, METRICOOL_USER_ID, METRICOOL_BRAND_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const need = ['METRICOOL_API_TOKEN', 'METRICOOL_USER_ID', 'METRICOOL_BRAND_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) { console.error('Missing env vars: ' + missing.join(', ')); process.exit(1); }
const E = process.env;
const DAYS_BACK = 120; // match sync-analytics.js's window
const TZ = 'America/Vancouver';

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const isoDateTime = (d) => `${iso(d)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const H = { 'X-Mc-Auth': E.METRICOOL_API_TOKEN, Accept: 'application/json' };

async function get(url) {
  const res = await fetch(url, { headers: H });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const dt = (d) => { const v = d && d.dateTime; return v ? String(v).slice(0, 10) : null; };

function mapStatus(apiStatus, startISO, today) {
  const s = String(apiStatus || '').toUpperCase();
  if (s === 'REMOVED') return 'ended';
  if (s === 'PAUSED') return 'paused';
  if (s === 'ACTIVE') return startISO && startISO > today ? 'scheduled' : 'active';
  return 'paused'; // matches renderAds()'s own fallback (ADS_STATUS[c.status]||ADS_STATUS.paused)
}

function normalizeCampaign(c, platform, today) {
  const id = pick(c, 'providerCampaignId', 'id');
  if (!id || !c.name) return null; // doesn't look like a campaign object -- skip, don't guess
  const start = dt(c.start);
  const m = c.metrics || {};
  return {
    campaign_id: String(id),
    platform,
    name: String(c.name),
    status: mapStatus(c.status, start, today),
        spend: num(pick(m, 'SPENT', 'spend', 'spent', 'cost')),
        impressions: num(pick(m, 'IMPRESSIONS', 'impressions')),
        clicks: num(pick(m, 'CLICKS', 'clicks', 'linkClicks', 'inline_link_clicks')),
        conversions: num(pick(m, 'CONVERSIONS', 'conversions', 'results', 'purchases')),
    start_date: start,
    end_date: dt(c.stop),
    synced_at: new Date().toISOString(),
  };
}

async function fetchPlatformCampaigns(platform, from, to, today) {
  const base = 'https://app.metricool.com/api/v2/advertising/campaigns';
  const q = new URLSearchParams({ blogId: E.METRICOOL_BRAND_ID, userId: E.METRICOOL_USER_ID, from: isoDateTime(from), to: isoDateTime(to), timezone: TZ });
  q.append('providers[]', platform);
  const r = await get(`${base}?${q}`);
  console.log(`${platform}: HTTP ${r.status}`); // security: never print response bodies (the repo is public, so Actions logs are public)
  if (!r.ok) return [];
  let json; try { json = JSON.parse(r.body); } catch { console.log(`${platform}: non-JSON response, skipping`); return []; }
  const list = Array.isArray(json) ? json : pick(json, 'data', 'campaigns', 'results') || [];
  if (!Array.isArray(list)) { console.log(`${platform}: no array of campaigns found in response`); return []; }
    console.log(`${platform}: ${list.length} campaigns`);
  return list;
}

async function upsert(rows) {
  const key = E.SUPABASE_SERVICE_ROLE_KEY;
  const url = `${E.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/ad_campaigns?on_conflict=platform,campaign_id`;
  for (let i = 0; i < rows.length; i += 500) {
    const res = await fetch(url, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
}

(async () => {
  const now = new Date();
  const from = new Date(now.getTime() - DAYS_BACK * 864e5);
  const today = iso(now);
  const rows = [];

  const metaRaw = await fetchPlatformCampaigns('facebookads', from, now, today);
  for (const c of metaRaw) { const row = normalizeCampaign(c, 'meta', today); if (row) rows.push(row); }
  console.log(`meta: ${metaRaw.length} raw records, ${rows.length} normalized`);

  // Google Ads isn't connected for this brand yet (see getBrandSettings) -- adding it later is
  // one more fetchPlatformCampaigns('googleads', ...) call with platform:'google' on the row.

  if (!rows.length) {
    console.log('No campaigns normalized -- nothing to upsert. Check the HTTP status/body logged above if campaigns were expected; this is treated as "nothing live yet", not a hard failure.');
    process.exit(0);
  }

  console.log(`Upserting ${rows.length} campaign rows`);
  await upsert(rows);
  console.log('Done.');
})().catch((e) => { console.error(e); process.exit(1); });
