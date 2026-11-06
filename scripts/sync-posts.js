// Pulls every published post (Instagram feed + reels, Facebook, LinkedIn, YouTube) from the
// Metricool v2 analytics API and writes data/posts.json for the dashboard's Top content,
// channel Content tabs and the report. Added Nov 2026: until now the post list was a fixed
// snapshot that ended Sep 26, so newer posts never appeared.
// Env: METRICOOL_API_TOKEN, METRICOOL_USER_ID, METRICOOL_BRAND_ID. Node 20, no dependencies.
const fs = require('fs');
const path = require('path');

const need = ['METRICOOL_API_TOKEN', 'METRICOOL_USER_ID', 'METRICOOL_BRAND_ID'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) { console.error('Missing env vars: ' + missing.join(', ')); process.exit(1); }
const E = process.env;
const TZ = 'America/Vancouver';
// Pull everything from Jan 1, 2024 (the yearly reports cover the last 3 calendar years)
const HISTORY_FROM = new Date(Date.UTC(2024, 0, 1));
const CHUNK_DAYS = 180; // ask Metricool for at most ~6 months per request
const OUT = path.join(__dirname, '..', 'data', 'posts.json');
const H = { 'X-Mc-Auth': E.METRICOOL_API_TOKEN, Accept: 'application/json' };

// [dashboard channel, label for logs, endpoint paths to try (first that returns posts wins), forced type]
const SOURCES = [
  ['ig', 'instagram posts', ['/api/v2/analytics/posts/instagram'], null],
  ['ig', 'instagram reels', ['/api/v2/analytics/reels/instagram'], 'Reel'],
  ['fb', 'facebook posts', ['/api/v2/analytics/posts/facebook'], null],
  ['fb', 'facebook reels', ['/api/v2/analytics/reels/facebook'], 'Reel'],
  ['li', 'linkedin posts', ['/api/v2/analytics/posts/linkedin'], null],
  ['yt', 'youtube videos', ['/api/v2/analytics/videos/youtube', '/api/v2/analytics/posts/youtube', '/api/v2/analytics/youtube/videos'], 'Video'],
];

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

async function get(url) {
  const res = await fetch(url, { headers: H });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

// Find the array of post objects anywhere in the response.
function findList(json) {
  if (Array.isArray(json)) return json.some((x) => x && typeof x === 'object' && !Array.isArray(x)) ? json : null;
  if (json && typeof json === 'object') {
    for (const k of ['data', 'posts', 'reels', 'videos', 'items', 'results', 'values']) {
      const l = findList(json[k]);
      if (l) return l;
    }
    for (const v of Object.values(json)) { const l = findList(v); if (l) return l; }
  }
  return null;
}

// Read a field by trying several names, also one level down in nested objects (e.g. metrics.reach).
function pick(o, names) {
  for (const n of names) {
    if (o[n] != null && o[n] !== '') return o[n];
  }
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const n of names) if (v[n] != null && v[n] !== '' && typeof v[n] !== 'object') return v[n];
    }
  }
  return null;
}
const num = (v) => { if (v == null || v === '') return null; if (typeof v === 'object') v = v.value ?? v.total ?? v.count; const x = Number(v); return Number.isFinite(x) ? x : null; };

// Returns { date: 'YYYY-MM-DD', time: 'HH:MM' } in the brand's local time, as Metricool shows it.
function toLocal(v) {
  if (v == null) return null;
  if (typeof v === 'object') v = v.dateTime ?? v.date ?? v.timestamp ?? null;
  if (v == null) return null;
  const s = String(v);
  let d;
  if (/^\d{14}$/.test(s)) {
    // Metricool's compact UTC stamp (YYYYMMDDHHMMSS). Metricool's own post list shows these at UTC-7
    // (checked against the Metricool Posts screen, Nov 2026), so convert the same way to match it exactly.
    const u = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)) - 7 * 3600e3;
    d = new Date(u);
    return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
  }
  if (/^\d{8}$/.test(s)) return { date: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, time: null };
  // a local wall-clock time with no offset (Metricool's {dateTime, timezone} objects): use as is
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) return { date: s.slice(0, 10), time: s.slice(11, 16) };
  if (/^\d{10,13}$/.test(s)) d = new Date(s.length === 10 ? +s * 1000 : +s);
  else d = new Date(s);
  if (isNaN(d)) return /^\d{4}-\d{2}-\d{2}/.test(s) ? { date: s.slice(0, 10), time: null } : null;
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = (t) => f.find((x) => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` };
}

// Every numeric metric Metricool returns for the post, under Metricool's own field names
// (nested objects are flattened one level, e.g. metrics.reach -> reach). Ids and dates are skipped.
const SKIP = /^(id|ids)$|_ids?$|date|time(stamp|zone)?$|^created|^published|url$|link$|^type$/i;
const SKIP_CASE = /[a-z](Id|Ids|ID)$/; // postId, businessId... (case-sensitive so 'reachPaid' is kept)
function allMetrics(o) {
  const m = {};
  const add = (k, v) => {
    if ((SKIP.test(k) || SKIP_CASE.test(k)) && !/watch|Watched|viewTotalTime/i.test(k)) return;
    if (typeof v === 'boolean' || v == null || v === '') return;
    if (typeof v === 'object') return;
    const x = Number(v);
    if (Number.isFinite(x) && !(typeof v === 'string' && /^\d{12,}$/.test(v))) m[k] = x;
  };
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) { for (const [k2, v2] of Object.entries(v)) add(k2 in o ? `${k}.${k2}` : k2, v2); }
    else add(k, v);
  }
  return m;
}

function typeLabel(ch, raw, forced) {
  if (forced) return forced;
  const t = String(raw || '').toUpperCase();
  if (/REEL/.test(t)) return 'Reel';
  if (/SHORT/.test(t)) return 'Short';
  if (/VIDEO/.test(t)) return ch === 'ig' ? 'Reel' : 'Video';
  if (/CAROUSEL|ALBUM|MULTI/.test(t)) return ch === 'fb' ? 'Album' : ch === 'li' ? 'Multi-image' : 'Carousel';
  if (/TEXT|STATUS|ARTICLE|LINK/.test(t)) return 'Text';
  if (/PHOTO|IMAGE|PICTURE/.test(t)) return ch === 'fb' ? 'Photo' : 'Image';
  return ch === 'fb' ? 'Photo' : ch === 'yt' ? 'Video' : 'Image';
}

function title(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const first = t.split(/(?<=[.!?])\s/)[0];
  const s = first.length <= 90 ? first : first.slice(0, 87).replace(/\s+\S*$/, '') + '…';
  return s.replace(/[|`\\]/g, ' ');
}

function normalize(ch, o, forced) {
  const url = pick(o, ['url', 'reelUrl', 'watchUrl', 'permalink', 'link', 'postUrl', 'publicUrl', 'shareUrl', 'videoUrl', 'postLink']);
  const when = toLocal(pick(o, ['publishedAt', 'created', 'createdAt', 'timestamp', 'date', 'publicationDate', 'dateTime', 'published']));
  if (!url || !when) return null;
  const { date, time } = when;
  const likes = num(pick(o, ['likes', 'reactions', 'likeCount', 'reactionsCount']));
  const comments = num(pick(o, ['comments', 'commentsCount', 'commentCount']));
  const saves = num(pick(o, ['saved', 'saves']));
  const shares = num(pick(o, ['shares', 'shared', 'sharesCount', 'reposts']));
  const clicks = num(pick(o, ['clicks', 'linkclicks', 'linkClicks', 'postClicks']));
  let inter = num(pick(o, ['interactions', 'totalInteractions', 'engagements']));
  if (inter == null && [likes, comments, saves, shares].some((x) => x != null)) inter = (likes || 0) + (comments || 0) + (saves || 0) + (shares || 0);
  // first non-zero value wins, so a 0 "video views" on a photo post doesn't hide its impressions
  const firstNZ = (names) => { let zero = null; for (const n of names) { const x = num(pick(o, [n])); if (x) return x; if (x === 0) zero = 0; } return zero; };
  const views = firstNZ(ch === 'li' ? ['impressions', 'views', 'videoViews'] : ['views', 'videoViews', 'plays', 'impressions', 'viewCount']);
  let reach = num(pick(o, ['reach', 'impressionsUnique', 'uniqueImpressions', 'postImpressionsUnique']));
  if (reach === 0) reach = null; // Facebook reels report 0 reach; leave it blank instead
  if (reach == null && ch === 'li') reach = views; // LinkedIn company pages only report impressions
  const watch = num(pick(o, ['averageWatchTime', 'avgWatchTime', 'videoAvgTimeWatched', 'averageViewDuration', 'avgTimeWatched']));
  return {
    ch, date, type: typeLabel(ch, pick(o, ['type', 'mediaType', 'media_type', 'postType', 'contentType']), forced),
    title: title(pick(o, ['content', 'text', 'caption', 'message', 'comment', 'commentary', 'title', 'description'])) || '(no caption)',
    url: String(url), time, views, reach, inter, likes, comments, saves, shares, clicks, watch,
    m: allMetrics(o),
  };
}

// One request for one date window; returns { items } on success or null when this path/param style doesn't work
async function fetchWindow(p, v, ch, label, forced, from, to) {
  const span = v === 'from' ? { from: `${ymd(from)}T00:00:00`, to: `${ymd(to)}T23:59:59` } : { start: `${ymd(from)}T00:00:00`, end: `${ymd(to)}T23:59:59` };
  const q = new URLSearchParams({ blogId: E.METRICOOL_BRAND_ID, userId: E.METRICOOL_USER_ID, timezone: TZ, ...span });
  const r = await get(`https://app.metricool.com${p}?${q}`);
  if (!r.ok) return { error: `HTTP ${r.status} ${r.body.slice(0, 160)}` };
  let json; try { json = JSON.parse(r.body); } catch { return { error: 'non-JSON' }; }
  const list = findList(json) || [];
  return { list, raw: r.body };
}

async function fetchSource(ch, label, paths, forced, from, to) {
  // find the endpoint + parameter style that works, using the most recent window
  const windows = [];
  for (let e = new Date(to); e > from; ) { const s = new Date(Math.max(from.getTime(), e.getTime() - CHUNK_DAYS * 864e5)); windows.push([s, new Date(e)]); e = new Date(s.getTime() - 864e5); }
  for (const p of paths) {
    for (const v of ['from', 'start']) {
      const first = await fetchWindow(p, v, ch, label, forced, windows[0][0], windows[0][1]);
      if (first.error) { console.log(`  skip ${label} ${p} (${v}): ${first.error}`); continue; }
      let items = first.list;
      if (items.length) console.log(`  ${label}: fields ${Object.keys(items[0]).join(', ')}`);
      for (const [s, e] of windows.slice(1)) {
        const w = await fetchWindow(p, v, ch, label, forced, s, e);
        if (w.error) { console.log(`  ${label} ${ymd(s)}..${ymd(e)}: ${w.error}`); continue; }
        items = items.concat(w.list);
      }
      if (!items.length) { console.log(`  ${label} ${p}: 0 items, raw ${first.raw.slice(0, 200)}`); continue; }
      const out = items.map((o) => normalize(ch, o, forced)).filter(Boolean);
      if (!out.length) { console.log(`  ${label}: could not read url/date from items, sample ${JSON.stringify(items[0]).slice(0, 400)}`); continue; }
      console.log(`  ${label}: ${items.length} items over ${windows.length} windows`);
      return out;
    }
  }
  return null;
}

const byDate = (a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
// YouTube keeps its id in ?v=, so keep that; drop query strings everywhere else
const keyOf = (u) => { const v = /[?&]v=([\w-]+)/.exec(String(u)); return v ? 'yt:' + v[1] : String(u).toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, ''); };

(async () => {
  const to = new Date();
  const from = HISTORY_FROM;
  const all = new Map();
  let ok = 0;
  const failed = new Set();
  const oldest = {}; // earliest post date each source returned this run
  const srcKey = (ch, isReel) => `${ch}:${isReel && (ch === 'ig' || ch === 'fb') ? 'reel' : 'post'}`;
  for (const [ch, label, paths, forced] of SOURCES) {
    try {
      const posts = await fetchSource(ch, label, paths, forced, from, to);
      if (!posts) { console.log(`FAIL ${label}: no posts returned`); failed.add(srcKey(ch, forced === 'Reel')); continue; }
      ok++;
      { const sk = srcKey(ch, forced === 'Reel'); const old = posts.map((p) => p.date).sort()[0]; if (!oldest[sk] || old < oldest[sk]) oldest[sk] = old; }
      for (const p of posts) {
        const k = keyOf(p.url);
        const prev = all.get(k);
        // reels can appear in both the feed and reels lists: keep the one with more numbers filled in
        if (!prev || Object.values(p).filter((x) => x != null).length >= Object.values(prev).filter((x) => x != null).length) all.set(k, p);
      }
      const latest = posts.map((p) => p.date).sort().pop();
      console.log(`${label}: ${posts.length} posts, latest ${latest}`);
    } catch (e) { console.log(`  error ${label}: ${e.message}`); failed.add(srcKey(ch, forced === 'Reel')); }
  }
  const posts = [...all.values()].sort(byDate);
  if (!posts.length) { console.error('No posts from any network; leaving data/posts.json unchanged'); process.exit(1); }
  // keep the previous file's posts for any source that failed this run, so one bad call never empties a channel
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    for (const p of prev.posts || []) {
      const sk = srcKey(p.ch, p.type === 'Reel');
      // keep it if its source failed this run, or it is older than anything Metricool sent back (history we already had)
      if (!all.has(keyOf(p.url)) && (failed.has(sk) || (oldest[sk] && p.date < oldest[sk]))) posts.push(p);
    }
    posts.sort(byDate);
  } catch {}
  // only rewrite the file when the posts or their numbers changed (avoids an empty commit every run)
  let same = false;
  try { same = JSON.stringify(JSON.parse(fs.readFileSync(OUT, 'utf8')).posts) === JSON.stringify(posts); } catch {}
  if (same) { console.log(`No change in ${posts.length} posts`); return; }
  fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), count: posts.length, posts }, null, 1) + '\n');
  console.log(`Wrote ${posts.length} posts (${ok}/${SOURCES.length} sources ok) to data/posts.json`);
})().catch((e) => { console.error(e); process.exit(1); });
