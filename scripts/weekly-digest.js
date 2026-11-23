// Weekly inbox digest for Cloverdale Paint. Writes ONE plain-text .eml into ALERT_DIR (the workflow's
// email step sends every .eml in that folder) and records reply_settings.last_digest_at.
// Runs only on Monday from 8:00 (America/Vancouver), at most once per 6 days. FORCE_DIGEST=1 skips the day and hour check.
// Privacy: prints counts only. Never customer text and never the top words (they are only in the email).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ALERT_DIR, MAIL_FROM, ALERT_TO, optional FORCE_DIGEST
'use strict';
const fs = require('fs');
const path = require('path');

const TZ = 'America/Vancouver';
const DAY = 24 * 3600 * 1000;
const STOP = new Set(('the and for are you your yours with this that these those have has had can could would should will just what which who whom whose when where why how does did not but from any get got ' +
  'use using our out about there their they them its was were like want need know some much many more also been into than then very really please thanks thank hello hey one two too all see let ask may might ' +
  'must shall his her she him yes his hers ours its let your yours you about after again been being both each few other over such only own same too very can will just than then once here there when ' +
  'while below above between through during before under until against off down further these those because while it\'s i\'m don\'t didn\'t isn\'t').split(/\s+/));

function vancouverParts(ms) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(new Date(ms));
  const g = (t) => f.find((p) => p.type === t).value;
  return { weekday: g('weekday'), hour: Number(g('hour')), date: `${g('year')}-${g('month')}-${g('day')}` };
}

async function main(opts) {
  opts = opts || {};
  const E = process.env;
  if (!E.ALERT_DIR) { console.log('digest: no ALERT_DIR'); return 0; }
  if (!E.ALERT_TO) { console.log('digest: no ALERT_TO'); return 0; }
  const need = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const missing = need.filter((k) => !E[k]);
  if (missing.length) { console.error('Missing env vars: ' + missing.join(', ')); return 1; }
  const now = opts.now != null ? opts.now : Date.now();
  const SB = E.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/';
  const KEY = E.SUPABASE_SERVICE_ROLE_KEY;
  async function sb(method, table, qs, body, prefer) {
    const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${SB}${table}${qs ? '?' + qs : ''}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new Error(`Supabase ${res.status} on ${table}`);
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }

  const vp = vancouverParts(now);
  const force = String(E.FORCE_DIGEST || '') === '1';
  if (!force && !(vp.weekday === 'Mon' && vp.hour >= 8)) { console.log('digest: not Monday after 8:00, skipping'); return 0; }
  const settings = ((await sb('GET', 'reply_settings', 'id=eq.1&select=last_digest_at')) || [])[0];
  if (!settings) { console.error('No reply_settings row'); return 1; }
  const last = settings.last_digest_at ? Date.parse(settings.last_digest_at) : null;
  if (last != null && now - last < 6 * DAY) { console.log('digest: already sent this week'); return 0; }

  // last 7 days of messages
  const fromMs = now - 7 * DAY;
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const page = await sb('GET', 'inbox_messages', `received_at=gte.${encodeURIComponent(new Date(fromMs).toISOString())}&select=category,status,priority,text,platform,kind,received_at&limit=1000&offset=${off}`);
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const tally = (key) => rows.reduce((m, r) => { const k = r[key] || 'none'; m[k] = (m[k] || 0) + 1; return m; }, {});
  const byStatus = tally('status'), byCat = tally('category');
  const high = rows.filter((r) => r.priority === 'high').length;
  const offTopic = rows.filter((r) => r.category === 'off_topic').length;
  const waitingDms = rows.filter((r) => r.kind === 'dm' && r.status === 'needs_person' && Date.parse(r.received_at) < now - 5 * DAY).length;
  const freq = {};
  for (const r of rows) {
    if (r.category !== 'general') continue;
    const t = String(r.text || '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[‘’]/g, "'");
    for (const w of t.match(/[a-z']{3,}/g) || []) { if (!STOP.has(w) && !/^'|'$/.test(w)) freq[w] = (freq[w] || 0) + 1; }
  }
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10);

  const range = `${vancouverParts(fromMs).date} to ${vp.date}`;
  const list = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`).join('\r\n') || '  none';
  const body = [
    `Inbox digest for ${range}`, '',
    `Messages received: ${rows.length}`,
    `High-priority complaints: ${high}`,
    `Off-topic (ignored): ${offTopic}`,
    `Direct messages waiting more than 5 days: ${waitingDms}`, '',
    'By status:', list(byStatus), '',
    'By category:', list(byCat), '',
    'Most common words in "general" messages (to help you decide whether a new rule is worth adding):',
    top.length ? top.map(([w, c]) => `  ${w}: ${c}`).join('\r\n') : '  none', '',
  ].join('\r\n');
  const clean = (x) => String(x || '').replace(/[\r\n]+/g, ' ');
  const eml = [`From: ${clean(E.MAIL_FROM)}`, `To: ${clean(E.ALERT_TO)}`, `Subject: Cloverdale inbox: weekly digest ${range}`, `Date: ${new Date(now).toUTCString()}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', body, ''].join('\r\n');
  fs.mkdirSync(E.ALERT_DIR, { recursive: true });
  fs.writeFileSync(path.join(E.ALERT_DIR, `digest-${now}.eml`), eml, 'utf8');
  const iso = new Date(now).toISOString();
  await sb('PATCH', 'reply_settings', 'id=eq.1', { last_digest_at: iso, updated_at: iso }, 'return=minimal');
  console.log(`digest: ${rows.length} messages, high priority ${high}, off-topic ${offTopic}`);
  return 0;
}

module.exports = { main };
if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => { console.error('Failed: ' + (e && /^Supabase \d+ on \w+$/.test(String(e.message)) ? e.message : (e && e.name) || 'error')); process.exit(1); });
}
