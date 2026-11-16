// Read-only check: does the analytics API token give access to the inbox (comments and messages)?
// It only sends GET requests. It never replies, never changes anything.
// The repo and its Action logs are public, so this prints ONLY status codes, counts and field
// names. It never prints message text, names or ids.
// Env: METRICOOL_API_TOKEN, METRICOOL_USER_ID, METRICOOL_BRAND_ID. Node 20, no dependencies.
const need = ['METRICOOL_API_TOKEN', 'METRICOOL_USER_ID', 'METRICOOL_BRAND_ID'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) { console.error('Missing env vars: ' + missing.join(', ')); process.exit(1); }
const E = process.env;
const BASE = 'https://app.metricool.com/api';
const H = { 'X-Mc-Auth': E.METRICOOL_API_TOKEN, Accept: 'application/json' };

const CHECKS = [
  ['instagram messages', '/v2/inbox/conversations', { provider: 'INSTAGRAM' }],
  ['facebook messages', '/v2/inbox/conversations', { provider: 'FACEBOOK' }],
  ['instagram comments', '/v2/inbox/post-comments', { provider: 'INSTAGRAM' }],
  ['facebook comments', '/v2/inbox/post-comments', { provider: 'FACEBOOK' }],
  ['all messages (no filter)', '/v2/inbox/conversations', {}],
  ['all comments (no filter)', '/v2/inbox/post-comments', {}],
];

// Field names only, two levels deep, values replaced by their type.
function shape(v, depth) {
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth)] : [];
  if (v && typeof v === 'object') {
    if (depth <= 0) return 'object';
    const o = {};
    for (const k of Object.keys(v)) o[k] = shape(v[k], depth - 1);
    return o;
  }
  return v === null ? 'null' : typeof v;
}
function findList(j) {
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object') {
    for (const k of ['data', 'conversations', 'comments', 'items', 'results']) if (Array.isArray(j[k])) return j[k];
    for (const v of Object.values(j)) if (Array.isArray(v)) return v;
  }
  return null;
}

(async () => {
  let ok = 0;
  for (const [label, path, extra] of CHECKS) {
    const q = new URLSearchParams({ blogId: E.METRICOOL_BRAND_ID, userId: E.METRICOOL_USER_ID, ...extra });
    let line = `${label}: `;
    try {
      const res = await fetch(`${BASE}${path}?${q}`, { headers: H });
      const body = await res.text();
      line += `HTTP ${res.status}`;
      let j = null;
      try { j = JSON.parse(body); } catch (_) {}
      if (res.ok && j != null) {
        ok++;
        const list = findList(j);
        line += `, items: ${list ? list.length : 'no list found'}`;
        console.log(line);
        console.log('  top level: ' + JSON.stringify(shape(j, 1)));
        if (list && list.length) console.log('  one item, field names only: ' + JSON.stringify(shape(list[0], 3)));
      } else {
        // Error bodies can name valid parameters; they contain no customer data.
        console.log(line + (res.ok ? ', not JSON' : `, error: ${body.slice(0, 300).replace(/\s+/g, ' ')}`));
      }
    } catch (e) {
      console.log(line + 'request failed: ' + e.message);
    }
  }
  console.log(`\nResult: ${ok} of ${CHECKS.length} checks returned data.`);
  console.log(ok ? 'Inbox access works with this token.' : 'Inbox access did not work with this token.');
})();
