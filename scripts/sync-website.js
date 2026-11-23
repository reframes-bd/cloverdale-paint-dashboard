// Copies the public website into two Supabase tables used by the inbox auto-reply:
//   site_stores: every store (address, phone, hours) from /store-locations and each store page
//   site_pages:  every useful page from sitemap_new.xml (title, description, type, section, keywords)
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (not needed with DRY=1). Node 20, no dependencies.
// DRY=1: no Supabase calls; writes tests/out-stores.json and tests/out-pages.json for inspection.
// Only counts and a few titles are printed (the repo and its Action logs are public).
const fs = require('fs');
const path = require('path');

const DRY = process.env.DRY === '1';
const E = process.env;
if (!DRY) {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !E[k]);
  if (missing.length) { console.error('Missing env vars: ' + missing.join(', ')); process.exit(1); }
}
const SITE = 'https://www.cloverdalepaint.com';
const UA = 'CloverdaleDashboardBot/1.0';
const CONCURRENCY = 4;
const PAUSE_MS = 150;
const TIMEOUT_MS = 20000;
const MIN_STORES = 60;
const MIN_PAGES = 300;
const BATCH = 200;
const KEEP_RATIO = 0.9;
const OUT_DIR = path.join(__dirname, '..', 'tests');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- polite fetching ----------
async function getOnce(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  const type = res.headers.get('content-type') || '';
  return { ok: res.ok, status: res.status, type, body: await res.text() };
}
async function getPage(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await getOnce(url);
      if (r.ok || (r.status < 500 && r.status !== 429)) return r;
    } catch (e) { /* retry once */ }
    if (attempt === 0) await sleep(1000);
  }
  return null;
}
// Runs fn over items, at most CONCURRENCY at a time, with a pause after each request.
async function pool(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
      await sleep(PAUSE_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

// ---------- html helpers ----------
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '-', mdash: '-', eacute: 'é', egrave: 'è', reg: '®', trade: '™', copy: '©' };
function decode(s) {
  return String(s == null ? '' : s)
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (NAMED[n.toLowerCase()] !== undefined ? NAMED[n.toLowerCase()] : m));
}
const squash = (s) => decode(s).replace(/\s+/g, ' ').trim();
const textOf = (html) => squash(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '));
// inner html of the first element whose id ends with the given suffix
function spanById(html, suffix) {
  const m = html.match(new RegExp('<span[^>]*id="[^"]*' + suffix + '"[^>]*>([\\s\\S]*?)</span>', 'i'));
  return m ? m[1] : null;
}
function toTitle(s) { return s.replace(/\b([a-z])/g, (m, c) => c.toUpperCase()); }

// ---------- stores ----------
// Returns [{store_id, url, name, city, province, linkText}] in page order.
// BC cities carry hdProvince/hdCity inputs; the other provinces (accordions) carry hdOtherProvince/hdOtherCity.
function parseStoreList(html) {
  const re = /id="[^"]*hd(?:Other)?Province"\s+value="([^"]*)"|id="[^"]*hd(?:Other)?City"\s+value="([^"]*)"|<a\s+[^>]*href=(['"])([^'"]*\/location-detail\/(\d+)\/[^'"]*)\3([^>]*)>([\s\S]*?)<\/a>/gi;
  let province = '', city = '', m;
  const byId = new Map();
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) { province = decode(m[1]).trim().toUpperCase(); continue; }
    if (m[2] !== undefined) { city = decode(m[2]).trim(); continue; }
    const id = +m[5];
    if (byId.has(id)) continue;
    const href = m[4];
    const tm = (m[6] || '').match(/title=(['"])([^'"]*)\1/i);
    const linkText = textOf(m[7]);
    let name = tm ? squash(tm[2]).replace(/\s+paint store near me$/i, '') : '';
    name = name.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
    if (!name) { const slug = decodeURIComponent(href.split('/location-detail/' + id + '/')[1] || ''); name = toTitle(slug.trim()); }
    byId.set(id, { store_id: id, url: new URL(href, SITE).href, name, city, province, linkText });
  }
  return [...byId.values()];
}

function parseHoursPart(inner) {
  if (inner == null) return null;
  let s = String(inner).replace(/<strong>[\s\S]*?<\/strong>/gi, ' ');
  s = textOf(s).replace(/^(M2F|Mon[a-z ]*|Sat[a-z]*|Sun[a-z]*)\s*:\s*/i, '');
  return s || null;
}

function parseStorePage(html, base) {
  const out = Object.assign({}, base);
  const nameText = textOf(spanById(html, 'lbl_corp_store_name'));
  const no = textOf(spanById(html, 'lbl_storeid'));
  out.store_no = no ? 'Store # ' + no : null;
  const street = spanById(html, 'lbl_street_address');
  out.address = street ? squash(street.replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' ')).replace(/\s+,/g, ',').replace(/,\s*,/g, ',') : null;
  if (!out.province && out.address) { const pm = out.address.match(/,\s*([A-Z]{2})\s+[A-Z]\d[A-Z]/); if (pm) out.province = pm[1]; }
  if (!out.province && nameText) { const pm = nameText.match(/,\s*([A-Z]{2})\s*$/); if (pm) out.province = pm[1]; }
  if (!out.city) out.city = (base.linkText.split(',')[0] || '').trim();
  const phone = (h) => { if (h == null) return null; const a = h.match(/<a[^>]*>([\s\S]*?)<\/a>/i); const t = a ? textOf(a[1]) : textOf(h.replace(/<strong>[\s\S]*?<\/strong>/gi, ' ').replace(/<i[\s\S]*?<\/i>/gi, ' ')); return t || null; };
  out.phone = phone(spanById(html, 'lbl_phone'));
  out.text_phone = phone(spanById(html, 'lbl_cellPhone'));
  const em = html.match(/href=['"]mailto:([^'"?]+)/i);
  out.email = em ? decode(em[1]).trim() : null;
  const parts = [['Mon to Fri', 'lbl_MF_SH'], ['Sat', 'lbl_Sat_SH'], ['Sun', 'lbl_Sun_SH']]
    .map(([label, id]) => { const v = parseHoursPart(spanById(html, id)); return v ? label + ' ' + v : null; })
    .filter(Boolean);
  out.hours = parts.length ? parts.join(', ') : null;
  delete out.linkText;
  return out;
}

// ---------- pages ----------
function parseSitemap(xml) {
  const urls = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) urls.push(decode(m[1]).trim());
  return [...new Set(urls)];
}

const DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|csv|txt|jpe?g|png|gif|webp|svg|mp4|mov|xml)$/i;
// Returns a reason string when the url should be skipped, else null.
function skipReason(u) {
  let url;
  try { url = new URL(u); } catch (e) { return 'bad url'; }
  if (url.hostname.replace(/^www\./, '') !== 'cloverdalepaint.com') return 'other host';
  const p = decodeURIComponent(url.pathname).replace(/\/+$/, '');
  const segs = p.split('/').filter(Boolean);
  if (!segs.length) return null;
  const lower = p.toLowerCase();
  if (DOC_EXT.test(lower)) return 'document';
  if (lower.startsWith('/store-locations')) return 'store';
  if (lower === '/404') return 'error page';
  if (lower === '/google-search-result') return 'search page';
  if (lower === '/dealer-information/training' || lower.startsWith('/dealer-information/training/')) return 'dealer training';
  if (/\/thank-?you$/.test(lower) || /\/thanks$/.test(lower)) return 'thank-you';
  if (lower.includes('-test')) return 'test';
  if (lower === '/dealer-login' || lower.startsWith('/dealer-login/')) return 'login';
  const ci = segs.map((s) => s.toLowerCase()).indexOf('contact-us');
  if (ci >= 0) {
    const rest = segs.slice(ci + 1);
    if (rest[0] && rest[0].toLowerCase() === 'sales-departments') { if (rest.length > 2) return 'person'; }
    else if (rest.length > 1) return 'person';
    if (rest[0] && rest[0].toLowerCase() === 'sales-departments' && rest.length === 2) { /* department page, keep */ }
  }
  return null;
}

function classify(u) {
  const segs = decodeURIComponent(new URL(u).pathname).toLowerCase().split('/').filter(Boolean);
  const p = '/' + segs.join('/');
  const first = segs[0] || '';
  let section = 'home';
  if (first === 'professionals' || first === 'for-professionals') section = 'professional';
  else if (first === 'industrial') section = 'industrial';
  else if (first === 'about-us-overview') section = 'about';
  else if (first === 'dealer-information') section = 'professional';
  let type = 'other';
  if (p.startsWith('/for-your-home/product-paint')) type = 'product';
  else if (p.startsWith('/for-your-home/how-to-paint-stain')) type = 'howto';
  else if (segs.some((s) => s.startsWith('paint-colours')) || segs.includes('colour')) type = 'colour';
  else if (segs.includes('promotions-discounts') || first === 'fanclub') type = 'promotion';
  else if (segs.includes('careers') || first === 'careers') type = 'career';
  else if (segs.includes('contact-us')) type = 'contact';
  else if (segs.includes('blog')) type = 'blog';
  else if (first === 'professionals' || first === 'for-professionals') type = segs.includes('product-catalog') || segs.includes('architectural-paint') ? 'product' : 'professional';
  else if (first === 'industrial') type = 'industrial';
  else if (first === 'dealer-information') type = 'dealer';
  return { type, section };
}

function metaDescription(html) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/\bname\s*=\s*["']description["']/i.test(tag)) continue;
    const c = tag.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i);
    if (c) return squash(c[2]) || null;
  }
  return null;
}
function cleanTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let t = m ? squash(m[1].replace(/<[^>]+>/g, ' ')) : '';
  t = t.replace(/\s*[|\-–—]\s*Cloverdale Paint(s)?(\s*\|.*)?$/i, '').trim();
  return t || null;
}
function keywordsOf(title, u) {
  const segs = decodeURIComponent(new URL(u).pathname).split('/').filter(Boolean).slice(-2);
  const text = ((title || '') + ' ' + segs.join(' ')).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const words = text.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && /[a-z]/.test(w));
  return [...new Set(words)].join(' ');
}
function parsePage(u, html) {
  const title = cleanTitle(html);
  const { type, section } = classify(u);
  return { url: u, title, description: metaDescription(html), type, section, keywords: keywordsOf(title, u) };
}

// ---------- supabase ----------
const SB = () => E.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1';
const SBH = () => ({ apikey: E.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + E.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' });
async function sb(method, pathAndQuery, body, prefer) {
  const headers = Object.assign({}, SBH());
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(SB() + pathAndQuery, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(method + ' ' + pathAndQuery.split('?')[0] + ' -> ' + res.status + ' ' + text.slice(0, 200).replace(/\s+/g, ' '));
  return { res, text };
}
async function tableCount(table, key) {
  const { res } = await sb('GET', '/' + table + '?select=' + key + '&limit=1', undefined, 'count=exact');
  const m = (res.headers.get('content-range') || '').match(/\/(\d+)$/);
  return m ? +m[1] : 0;
}
async function writeTable(table, conflict, key, rows, runStart) {
  const stamped = rows.map((r) => Object.assign({}, r, { updated_at: runStart }));
  const before = await tableCount(table, key);
  for (let i = 0; i < stamped.length; i += BATCH) {
    await sb('POST', '/' + table + '?on_conflict=' + conflict, stamped.slice(i, i + BATCH), 'resolution=merge-duplicates,return=minimal');
  }
  let deleted = 0, note = 'delete skipped';
  if (before === 0 || rows.length >= KEEP_RATIO * before) {
    // every row seen in this run was stamped with runStart, so older rows are the ones no longer on the site
    const { res } = await sb('DELETE', '/' + table + '?updated_at=lt.' + encodeURIComponent(runStart), undefined, 'return=minimal,count=exact');
    const m = (res.headers.get('content-range') || '').match(/\/(\d+)$/);
    deleted = m ? +m[1] : 0;
    note = 'deleted ' + deleted;
  } else {
    note = 'delete skipped (parsed ' + rows.length + ' of ' + before + ' existing)';
  }
  console.log(table + ': upserted ' + rows.length + ', existing before ' + before + ', ' + note);
}

// ---------- main ----------
async function main() {
  const runStart = new Date().toISOString();

  // stores
  const list = await getPage(SITE + '/store-locations');
  if (!list || !list.ok) { console.error('Could not read the store list (status ' + (list ? list.status : 'none') + ')'); process.exit(1); }
  const entries = parseStoreList(list.body);
  console.log('store links found: ' + entries.length);
  const storeRes = await pool(entries, async (en) => {
    const r = await getPage(en.url);
    if (!r || !r.ok) return null;
    const s = parseStorePage(r.body, en);
    return s.address && s.city && s.province && s.name ? s : null;
  });
  const stores = storeRes.filter(Boolean).map((s) => ({
    store_id: s.store_id, store_no: s.store_no, name: s.name, city: s.city, province: s.province, address: s.address,
    phone: s.phone, text_phone: s.text_phone, email: s.email, hours: s.hours, url: s.url,
  }));
  console.log('stores parsed: ' + stores.length + ' of ' + entries.length);

  // pages
  const sm = await getPage(SITE + '/sitemap_new.xml');
  if (!sm || !sm.ok) { console.error('Could not read the sitemap (status ' + (sm ? sm.status : 'none') + ')'); process.exit(1); }
  const all = parseSitemap(sm.body);
  const skipped = {};
  const keep = [];
  for (const u of all) { const why = skipReason(u); if (why) skipped[why] = (skipped[why] || 0) + 1; else keep.push(u); }
  console.log('sitemap urls: ' + all.length + ', skipped: ' + JSON.stringify(skipped) + ', to fetch: ' + keep.length);
  const pageRes = await pool(keep, async (u) => {
    const r = await getPage(u);
    if (!r || !r.ok || !/html/i.test(r.type || 'text/html')) return null;
    return parsePage(u, r.body);
  });
  const JUNK_TITLES = ['dealer login', 'error page', 'site search'];
  const pages = pageRes.filter((p) => p && p.title && !JUNK_TITLES.includes(p.title.toLowerCase()));
  const failed = keep.length - pages.length;
  const perType = {};
  for (const p of pages) perType[p.type] = (perType[p.type] || 0) + 1;
  console.log('pages parsed: ' + pages.length + ', failed or without title: ' + failed + ', per type: ' + JSON.stringify(perType));

  if (stores.length < MIN_STORES || pages.length < MIN_PAGES) {
    console.error('Too few rows (stores ' + stores.length + ' < ' + MIN_STORES + ' or pages ' + pages.length + ' < ' + MIN_PAGES + '). Nothing written.');
    process.exit(1);
  }

  if (DRY) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'out-stores.json'), JSON.stringify(stores, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'out-pages.json'), JSON.stringify(pages, null, 2));
    console.log('DRY run: wrote tests/out-stores.json and tests/out-pages.json, no Supabase calls');
    return;
  }
  await writeTable('site_stores', 'store_id', 'store_id', stores, runStart);
  await writeTable('site_pages', 'url', 'url', pages, runStart);
  console.log('done');
}

main().catch((e) => { console.error('sync-website failed: ' + (e && e.message ? e.message : e)); process.exit(1); });
