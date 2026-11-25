// Hourly inbox auto-reply for Cloverdale Paint. Reads Instagram and Facebook comments and DMs through the
// inbox API, sorts each new one with scripts/reply-engine.js, saves the result to Supabase and, only when an
// admin has switched replies on (and dry run is off), posts the prepared reply.
// Privacy: this script prints counts, categories and status codes only. Never customer text, names or ids.
// Env: METRICOOL_API_TOKEN, METRICOOL_USER_ID, METRICOOL_BRAND_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional: ALERT_DIR, MAIL_FROM, ALERT_TO (alert emails are written as .eml files for the workflow to send)
'use strict';
const fs = require('fs');
const path = require('path');
const { classify } = require('./reply-engine.js');

const BASE = 'https://app.metricool.com/api';
const TZ = 'America/Vancouver';
const DAY = 24 * 3600 * 1000;
const DM_WINDOW_MS = 7 * DAY;
const MAX_FAILURES = 3;
const CLEAR_REJECT = [400, 404, 405, 422]; // only these let us try the next request shape

const need = ['METRICOOL_API_TOKEN', 'METRICOOL_USER_ID', 'METRICOOL_BRAND_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

// ---------- small helpers ----------
const low = (v) => String(v == null ? '' : v).trim().toLowerCase();
const toMs = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
};
const toIso = (v) => { const ms = toMs(v); return ms == null ? null : new Date(ms).toISOString(); };
const idsOf = (x) => {
  if (x == null) return [];
  if (Array.isArray(x)) return x.flatMap(idsOf);
  if (typeof x === 'object') return x.id != null ? [String(x.id)] : [];
  return [String(x)];
};
const idLike = (s) => /^\d{6,}$/.test(s) || (/^[\w-]{16,}$/.test(s) && /\d/.test(s));
const mask = (s) => String(s || '').replace(/[0-9]{3,}/g, 'N').replace(/[A-Za-z0-9_-]{16,}/g, 'ID').replace(/\s+/g, ' ').slice(0, 120);

const T = require('./email-templates.js');
const DASHBOARD_URL = 'https://reframes-bd.github.io/cloverdale-paint-dashboard/#sec-inbox';
const oneLine = (x) => String(x == null ? '' : x).replace(/\s*[\r\n]+\s*/g, ' ').trim();
// RFC 2047: encode a non-ASCII header value as folded =?UTF-8?B?...?= words (each word under 76 characters)
function encodeHeader(v) {
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words = []; let cur = '';
  for (const ch of Array.from(v)) {
    if (Buffer.byteLength(cur + ch) > 42) { words.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}
function vancouverStamp(iso) {
  const ms = Date.parse(iso || '');
  if (Number.isNaN(ms)) return 'unknown';
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms));
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return `${g('weekday')} ${g('month')} ${g('day')}, ${g('hour')}:${g('minute')} ${String(g('dayPeriod')).toLowerCase()}`;
}
function fromHeader(mailFrom) {
  const f = oneLine(mailFrom);
  return /[<"]/.test(f) ? f : `"Cloverdale inbox alerts" <${f}>`;
}
// Build one alert .eml: plain-text part (unchanged lines) plus a designed HTML part.
function buildEml(env, subject, bodyLines, now, htmlData) {
  const text = bodyLines.join('\r\n') + '\r\n';
  const html = htmlData ? T.alertHtml(Object.assign({ tz: TZ }, htmlData)) : null;
  return T.buildMime({ from: fromHeader(env.MAIL_FROM), to: env.ALERT_TO, subject, text, html, urgent: true, now });
}
function urgentReason(r) {
  if (r.category === 'pr') return 'Press or media request';
  if (/health line/.test(r.rule || '')) return 'Health or safety words';
  if (/complaint after an earlier complaint/.test(r.rule || '')) return 'Repeat complaint this week';
  return 'High-priority complaint';
}

// Start of "today" in America/Vancouver, as epoch ms.
function vancouverDayStart(nowMs) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(nowMs));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return nowMs - (g('hour') * 3600 + g('minute') * 60 + g('second')) * 1000 - (nowMs % 1000);
}

async function main() {
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) { console.error('Missing env vars: ' + missing.join(', ')); return 1; }
  const E = process.env;
  const SB = E.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/';
  const KEY = E.SUPABASE_SERVICE_ROLE_KEY;
  const IH = { 'X-Mc-Auth': E.METRICOOL_API_TOKEN, Accept: 'application/json', 'Content-Type': 'application/json' };
  const iq = (provider, extra) => new URLSearchParams(Object.assign({ blogId: E.METRICOOL_BRAND_ID, userId: E.METRICOOL_USER_ID, provider }, extra || {})).toString();

  // ----- Supabase REST -----
  const SAFE_NAMES = new Set(['inbox_messages', 'reply_rules', 'reply_settings', 'alert_log', 'site_stores', 'site_pages', 'public', 'platform', 'kind', 'external_id', 'thread_id', 'post_link', 'author_id', 'author_name', 'text', 'received_at', 'category', 'priority', 'rule', 'status', 'reply_text', 'replied_at', 'pages_used', 'error', 'id', 'message_id', 'reason', 'emailed', 'last_run_at', 'last_run_note', 'post_shape', 'last_digest_at', 'inbox_messages_platform_kind_external_id_key', 'inbox_messages_status_check', 'inbox_messages_priority_check', 'inbox_messages_platform_check', 'inbox_messages_kind_check']);
  async function sb(method, table, qs, body, prefer) {
    const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${SB}${table}${qs ? '?' + qs : ''}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) { // log code and message only, with quoted values masked: details can echo customer data
      let info = '';
      try { const j = JSON.parse(await res.text()); info = ` code ${j.code || '?'}: ${String(j.message || '').replace(/"([^"]*)"/g, (m, s) => (SAFE_NAMES.has(s) ? m : '"…"')).slice(0, 200)}`; } catch (e) { /* no detail */ }
      throw new Error(`Supabase ${res.status} on ${method} ${table}${info}`);
    }
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }
  async function getAll(table, qs) {
    const out = [];
    for (let off = 0; ; off += 1000) {
      const rows = await sb('GET', table, `${qs}&limit=1000&offset=${off}`);
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  }

  // ----- inbox API -----
  async function inboxGet(p, provider) {
    for (const lim of [true, false]) {
      try {
        const res = await fetch(`${BASE}${p}?${iq(provider, lim ? { limit: '100' } : {})}`, { headers: IH });
        if (res.ok) { const j = await res.json(); return { ok: true, status: res.status, data: Array.isArray(j && j.data) ? j.data : [] }; }
        if (!lim) return { ok: false, status: res.status };
      } catch (e) { if (!lim) return { ok: false, status: 0 }; }
    }
    return { ok: false, status: 0 };
  }

  // ----- 1. load settings, rules, stores, pages -----
  const settingsRows = await sb('GET', 'reply_settings', 'id=eq.1&select=*');
  const S = settingsRows && settingsRows[0];
  if (!S) { console.error('No reply_settings row'); return 1; }
  const rules = await sb('GET', 'reply_rules', 'active=eq.true&select=*&order=sort');
  if (!rules || !rules.length) { console.log('no rules loaded'); return 0; }
  const stores = await getAll('site_stores', 'select=*');
  const pages = await getAll('site_pages', 'select=url,title,type,keywords');
  const links = S.links || {};

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const dryRun = S.dry_run !== false;
  const switchOn = toMs(S.switch_on_at);
  const live = S.replies_on === true && !dryRun && switchOn != null;
  const maxRun = Number.isFinite(S.max_per_run) ? S.max_per_run : 15;
  const maxDay = Number.isFinite(S.max_per_day) ? S.max_per_day : 60;
  const postShape = Object.assign({}, S.post_shape || {});

  // history used for caps, "second message" and priorComplaint
  const dayStart = vancouverDayStart(now);
  const since = Math.min(dayStart, now - DAY);
  const repliedRows = (await sb('GET', 'inbox_messages', `status=eq.replied&replied_at=gte.${encodeURIComponent(new Date(since).toISOString())}&select=platform,thread_id,author_id,replied_at`)).map((r) => ({ ...r, ms: toMs(r.replied_at) }));
  const repliedToday = () => repliedRows.filter((r) => r.ms >= dayStart).length;
  const priorSet = new Set((await sb('GET', 'inbox_messages', `category=in.(complaint,complaint_high)&received_at=gte.${encodeURIComponent(new Date(now - 7 * DAY).toISOString())}&select=author_id`)).map((r) => r.author_id).filter(Boolean));

  // ----- 2 to 4. read providers and build candidates -----
  const ownExtra = (Array.isArray(S.own_ids) ? S.own_ids : []).map(low).filter(Boolean);
  const candidates = [];
  let read = 0, readFailures = 0, dmSkippedUnknownOwn = 0;

  for (const provider of ['INSTAGRAM', 'FACEBOOK']) {
    const platform = provider.toLowerCase();

    if (S.dms_on !== false) {
      const r = await inboxGet('/v2/inbox/conversations', provider);
      if (!r.ok) { console.log(`Could not read ${platform} messages: HTTP ${r.status}`); readFailures++; }
      else {
        read += r.data.length;
        // own id: settings, plus the one id that appears in the most distinct conversations
        const counts = new Map();
        for (const c of r.data) {
          const seen = new Set();
          for (const m of c.messages || []) for (const id of idsOf(m.from).concat(idsOf(m.to))) seen.add(id);
          for (const id of seen) counts.set(id, (counts.get(id) || 0) + 1);
        }
        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const own = new Set(ownExtra);
        if (ranked.length && ranked[0][1] >= 2 && (ranked.length === 1 || ranked[1][1] < ranked[0][1])) own.add(low(ranked[0][0]));
        if (!own.size) { dmSkippedUnknownOwn += r.data.length; }
        else {
          for (const c of r.data) {
            const msgs = (c.messages || []).map((m, i) => ({ m, i, t: toMs(m.publicationDateTime) })).sort((a, b) => (a.t == null || b.t == null ? a.i - b.i : a.t - b.t || a.i - b.i)).map((x) => x.m);
            let lastOwn = -1;
            msgs.forEach((m, i) => { if (idsOf(m.from).some((id) => own.has(low(id)))) lastOwn = i; });
            const run = msgs.slice(lastOwn + 1);
            if (!run.length) continue;
            const last = run[run.length - 1];
            const authorId = idsOf(last.from)[0] || null;
            const part = (c.participants || []).find((p) => p && authorId != null && String(p.id) === authorId);
            const recMs = toMs(last.publicationDateTime);
            candidates.push({
              platform, kind: 'dm', external_id: String(last.id), thread_id: String(c.id), post_link: null,
              author_id: authorId, author_name: part && part.name ? String(part.name) : null,
              text: run.map((m) => String(m.text || '').trim()).filter(Boolean).join(' '),
              received_at: toIso(last.publicationDateTime), outsideWindow: recMs != null && now - recMs > DM_WINDOW_MS,
              hasAttachment: run.some((m) => Array.isArray(m.attachments) && m.attachments.length > 0),
            });
          }
        }
      }
    }

    if (S.comments_on !== false) {
      const r = await inboxGet('/v2/inbox/post-comments', provider);
      if (!r.ok) { console.log(`Could not read ${platform} comments: HTTP ${r.status}`); readFailures++; }
      else {
        read += r.data.length;
        const own = new Set(ownExtra);
        for (const th of r.data) {
          const o = th && th.root && th.root.element && th.root.element.owner;
          if (typeof o === 'string') own.add(low(o));
          else if (o && typeof o === 'object') for (const k of ['id', 'name', 'username']) if ((typeof o[k] === 'string' || (k === 'id' && typeof o[k] === 'number')) && String(o[k]).trim()) own.add(low(o[k]));
        }
        const isOwn = (c) => idsOf(c.owner).concat(c.owner && typeof c.owner === 'object' ? [c.owner.name, c.owner.username].filter(Boolean).map(String) : []).some((id) => own.has(low(id)));
        for (const th of r.data) {
          const root = th.root;
          if (!root) continue;
          const all = [root].concat(Array.isArray(root.comments) ? root.comments : []).filter((c) => c && c.id != null);
          const ownList = all.filter(isOwn);
          for (const c of all) {
            if (isOwn(c)) continue;
            const cMs = toMs(c.creationDate);
            const answered = ownList.some((oc) => {
              const oMs = toMs(oc.creationDate);
              if (oMs == null || cMs == null || oMs <= cMs) return false;
              return c === root || (oc.parentId != null && String(oc.parentId) === String(c.id)) || (oc.parentId != null && c.parentId != null && String(oc.parentId) === String(c.parentId));
            });
            const ownerStr = idsOf(c.owner)[0] || (c.owner && c.owner.name) || null;
            // a reply under another customer's comment (not under ours, not under our post)
            const parent = c.parentId != null ? all.find((x) => String(x.id) === String(c.parentId)) : null;
            const replyToOther = !!(parent && parent !== c && !isOwn(parent) && (idsOf(parent.owner)[0] || null) !== ownerStr);
            const part = (th.participants || []).find((p) => p && ownerStr != null && String(p.id) === String(ownerStr));
            candidates.push({
              platform, kind: 'comment', external_id: String(c.id), thread_id: String(th.id), post_link: (root.element && root.element.link) || null,
              author_id: ownerStr == null ? null : String(ownerStr),
              author_name: part && part.name ? String(part.name) : (ownerStr != null && !idLike(String(ownerStr)) ? String(ownerStr) : null),
              text: String(c.text || ''), received_at: toIso(c.creationDate), answered, reply_to_other: replyToOther,
            });
          }
        }
      }
    }
  }

  // ----- 5. skip anything already saved -----
  const seenKeys = new Set(); const fresh = [];
  const keyOf = (c) => `${c.platform}|${c.kind}|${c.external_id}`;
  const groups = new Map();
  for (const c of candidates) { const k = c.platform + '|' + c.kind; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  for (const [g, list] of groups) {
    const [platform, kind] = g.split('|');
    const known = new Set();
    for (let i = 0; i < list.length; i += 50) {
      const ids = list.slice(i, i + 50).map((c) => `"${c.external_id.replace(/"/g, '')}"`).join(',');
      const rows = await sb('GET', 'inbox_messages', `platform=eq.${platform}&kind=eq.${kind}&external_id=in.(${encodeURIComponent(ids)})&select=external_id`);
      for (const r of rows) known.add(String(r.external_id));
    }
    for (const c of list) if (!known.has(c.external_id) && !seenKeys.has(keyOf(c))) { seenKeys.add(keyOf(c)); fresh.push(c); }
  }
  fresh.sort((a, b) => (toMs(a.received_at) || 0) - (toMs(b.received_at) || 0));

  // ----- 6 and 7. classify and decide -----
  const COLS = ['platform', 'kind', 'external_id', 'thread_id', 'post_link', 'author_id', 'author_name', 'text', 'received_at', 'category', 'priority', 'rule', 'status', 'reply_text', 'replied_at', 'pages_used', 'error'];
  const toRow = (c, o) => {
    const row = {}; for (const k of COLS) row[k] = k in o ? o[k] : (k in c ? c[k] : null);
    if (row.priority == null) row.priority = 'normal'; // NOT NULL columns: never send an explicit null
    if (row.status == null) row.status = 'new';
    return row;
  };

  const out = []; // {row, id}
  const catCounts = {};
  let postedThisRun = 0, failures = 0, postingStopped = false, limitHit = false, dbUpdateFailures = 0;
  const inserted = []; // rows with ids, for alerts

  async function postReply(c, text) {
    const q = iq(c.platform.toUpperCase());
    const shapes = c.kind === 'comment'
      ? [['comment-id', `${BASE}/v2/inbox/post-comments?${q}`, { commentId: c.external_id, message: text }],
         ['thread-id', `${BASE}/v2/inbox/post-comments?${q}`, { commentId: c.thread_id, message: text }],
         ['thread-path', `${BASE}/v2/inbox/post-comments/${encodeURIComponent(c.thread_id)}?${q}`, { commentId: c.external_id, message: text, text }]]
      : [['conversation-id', `${BASE}/v2/inbox/conversations?${q}`, { conversationId: c.thread_id, message: text }],
         ['conversation-path', `${BASE}/v2/inbox/conversations/${encodeURIComponent(c.thread_id)}?${q}`, { conversationId: c.thread_id, message: text, text }]];
    const remembered = shapes.filter((s) => s[0] === postShape[c.kind]);
    const tryList = remembered.length ? remembered : shapes;
    let lastErr = 'no shape accepted';
    for (const [label, url, body] of tryList) {
      let res, txt = '';
      try { res = await fetch(url, { method: 'POST', headers: IH, body: JSON.stringify(body) }); txt = await res.text(); }
      catch (e) { return { ok: false, error: 'network error, result unknown' }; } // unclear: never try again
      if (res.ok) return { ok: true, shape: label };
      let b = mask(txt);
      for (const secret of [text, c.author_name]) if (secret && b.includes(secret)) b = b.split(secret).join('[x]');
      lastErr = `HTTP ${res.status} ${b}`.trim();
      if (!CLEAR_REJECT.includes(res.status)) return { ok: false, error: lastErr }; // unclear: stop, never retry
    }
    return { ok: false, error: lastErr };
  }

  async function insertRows(rows, prefer) {
    const key = 'on_conflict=platform,kind,external_id';
    return (await sb('POST', 'inbox_messages', key, rows, prefer || 'resolution=ignore-duplicates,return=representation')) || [];
  }

  const pending = []; // rows to bulk insert at the end
  const usedByThread = new Map(); // reply versions already chosen per thread in this run, so neighbours get different wording
  for (const c of fresh) {
    let row;
    if (c.outsideWindow) {
      row = toRow(c, { status: 'no_reply', rule: 'dm: outside reply window' });
      pending.push(row); continue;
    }
    const tkey = c.platform + '|' + c.thread_id;
    if (!usedByThread.has(tkey)) usedByThread.set(tkey, new Set());
    const ctx = { rules, links, stores, pages, priorComplaint: !!(c.author_id && priorSet.has(c.author_id)), used: usedByThread.get(tkey) };
    const r = classify({ id: c.external_id, platform: c.platform, kind: c.kind, text: c.text, author_name: c.author_name, on_own_post: c.kind === 'comment', reply_to_other: !!c.reply_to_other }, ctx);
    if (r.action === 'reply' && Array.isArray(r.variants)) r.variants.forEach((v) => usedByThread.get(tkey).add(v));
    catCounts[r.category] = (catCounts[r.category] || 0) + 1;
    if (r.category === 'complaint' || r.category === 'complaint_high') { if (c.author_id) priorSet.add(c.author_id); }
    const base = { category: r.category, priority: r.priority, rule: r.rule, pages_used: r.pages_used };

    if (c.answered) { row = toRow(c, Object.assign(base, { priority: 'normal', status: 'no_reply', rule: `${r.rule} (answered already)` })); pending.push(row); continue; }
    if (c.hasAttachment) { row = toRow(c, Object.assign(base, { status: 'needs_person', rule: r.rule + ' (photo or file sent)' })); pending.push(row); continue; }
    if (r.action === 'no_reply') { row = toRow(c, Object.assign(base, { status: 'no_reply' })); pending.push(row); continue; }
    if (r.action === 'needs_person') { row = toRow(c, Object.assign(base, { status: 'needs_person' })); pending.push(row); continue; }

    // action reply
    const recMs = toMs(c.received_at);
    if (!live) { row = toRow(c, Object.assign(base, { status: 'would_reply', reply_text: r.reply })); pending.push(row); continue; }
    if (recMs != null && recMs < switchOn) { row = toRow(c, Object.assign(base, { status: 'no_reply', rule: r.rule + ' (before switch-on)' })); pending.push(row); continue; }
    const second = c.author_id && repliedRows.some((x) => x.ms >= now - DAY && x.platform === c.platform && x.thread_id === c.thread_id && x.author_id === c.author_id);
    if (second) { row = toRow(c, Object.assign(base, { status: 'needs_person', rule: r.rule + ' (second message)' })); pending.push(row); continue; }
    if (repliedToday() >= maxDay || postedThisRun >= maxRun) {
      limitHit = true;
      row = toRow(c, Object.assign(base, { status: 'needs_person', rule: r.rule + ' (limit reached)' })); pending.push(row); continue;
    }
    if (postingStopped) { row = toRow(c, Object.assign(base, { status: 'would_reply', reply_text: r.reply, rule: r.rule + ' (posting stopped)' })); pending.push(row); continue; }

    // Post. Save the row first so a reply can never be posted twice, even if a later step fails.
    row = toRow(c, Object.assign(base, { status: 'new', reply_text: r.reply }));
    const saved = await insertRows([row]);
    if (!saved.length) continue; // someone else saved it meanwhile
    const id = saved[0].id;
    const res = await postReply(c, r.reply);
    const patch = res.ok ? { status: 'replied', replied_at: new Date().toISOString() } : { status: 'failed', error: res.error };
    Object.assign(row, patch);
    try { await sb('PATCH', 'inbox_messages', `id=eq.${id}`, patch, 'return=minimal'); } catch (e) { dbUpdateFailures++; }
    inserted.push({ row, id });
    if (res.ok) {
      postedThisRun++;
      repliedRows.push({ platform: c.platform, thread_id: c.thread_id, author_id: c.author_id, ms: Date.now() });
      if (postShape[c.kind] !== res.shape) {
        postShape[c.kind] = res.shape;
        try { await sb('PATCH', 'reply_settings', 'id=eq.1', { post_shape: postShape }, 'return=minimal'); } catch (e) { dbUpdateFailures++; }
      }
    } else if (++failures >= MAX_FAILURES) postingStopped = true;
  }

  // ----- 8. save everything else -----
  for (let i = 0; i < pending.length; i += 100) {
    const saved = await insertRows(pending.slice(i, i + 100));
    for (const s of saved) { const row = pending.find((p) => p.platform === s.platform && p.kind === s.kind && p.external_id === s.external_id); if (row) inserted.push({ row, id: s.id }); }
  }

  // ----- 9. alerts -----
  const alerts = [];
  for (const { row, id } of inserted) if (row.priority === 'high') alerts.push({ reason: row.category === 'pr' ? 'press' : 'complaint_high', message_id: id, row });
  if (limitHit) alerts.push({ reason: 'limit', message_id: null });
  if (postingStopped) alerts.push({ reason: 'posting_failed', message_id: null });
  // emailed stays false here: only the workflow knows whether the mail was sent
  if (alerts.length) await sb('POST', 'alert_log', '', alerts.map((a) => ({ message_id: a.message_id, reason: a.reason })), 'return=minimal');
  if (E.ALERT_DIR && alerts.length) {
    fs.mkdirSync(E.ALERT_DIR, { recursive: true });
    alerts.forEach((a, i) => {
      let subject, lines, htmlData;
      if (a.row) {
        const r = a.row;
        const who = oneLine(r.author_name) || 'a customer';
        const platform = r.platform === 'facebook' ? 'Facebook' : 'Instagram';
        const kindWord = r.kind === 'dm' ? 'DM' : 'comment';
        const fixed = `Urgent: ${platform} ${kindWord} from  needs a person`;
        subject = `Urgent: ${platform} ${kindWord} from ${who.slice(0, Math.max(1, 120 - fixed.length))} needs a person`;
        const replied = r.status === 'replied' && r.reply_text ? `(posted) ${oneLine(r.reply_text)}`
          : r.status === 'would_reply' && r.reply_text ? `(prepared, not posted: dry run) ${oneLine(r.reply_text)}` : 'Nothing was posted';
        lines = [`Why: ${urgentReason(r)}`, `When: ${vancouverStamp(r.received_at)}`, `Where: ${platform} ${r.kind === 'dm' ? 'direct message' : 'comment'}`, `Customer: ${oneLine(r.author_name) || 'unknown'}`,
          `They wrote: ${oneLine(r.text)}`, `We replied: ${replied}`, `Post: ${r.post_link || 'no link'}`, `Open the dashboard Inbox: ${DASHBOARD_URL}`, `Rule: ${r.rule}`];
        htmlData = { row: r, reason: urgentReason(r) };
      } else if (a.reason === 'limit') {
        subject = 'Cloverdale inbox alert: auto-reply limit reached';
        lines = ['The reply limit was reached in this run. The remaining messages are marked "needs a person" in the dashboard Inbox.'];
        htmlData = { system: { title: 'Auto-reply limit reached', text: lines[0] } };
      } else {
        subject = 'Cloverdale inbox alert: auto-reply posting problem';
        lines = ['Posting replies failed three times in one run, so posting was stopped. The remaining replies are saved as "would reply" in the dashboard Inbox.'];
        htmlData = { system: { title: 'Auto-reply posting problem', text: lines[0] } };
      }
      fs.writeFileSync(path.join(E.ALERT_DIR, `alert-${Date.now()}-${i}.eml`), buildEml(E, subject, lines, now, htmlData), 'utf8');
    });
  }

  // ----- 10 and 11. summary -----
  const all = inserted.map((x) => x.row); // rows that were actually saved
  const cnt = (st) => all.filter((r) => r.status === st).length;
  // direct messages held for a person that are close to the 7-day reply limit
  const nearDeadline = (await sb('GET', 'inbox_messages', `kind=eq.dm&status=eq.needs_person&received_at=gte.${encodeURIComponent(new Date(now - 7 * DAY).toISOString())}&received_at=lt.${encodeURIComponent(new Date(now - 5 * DAY).toISOString())}&select=id`)).length;
  const note = `read ${read}, new ${all.length}, replied ${cnt('replied')}, would reply ${cnt('would_reply')}, needs a person ${cnt('needs_person')}, failed ${cnt('failed')}, off-topic ${all.filter((r) => r.category === 'off_topic').length}, general ${all.filter((r) => r.category === 'general').length}, DMs near reply deadline ${nearDeadline}`;
  await sb('PATCH', 'reply_settings', 'id=eq.1', { last_run_at: nowIso, last_run_note: note, updated_at: nowIso }, 'return=minimal');
  console.log(note);
  const cats = Object.entries(catCounts).sort().map(([k, v]) => `${k} ${v}`).join(', ');
  console.log('categories: ' + (cats || 'none'));
  if (readFailures) console.log(`inbox reads failed: ${readFailures}`);
  if (dmSkippedUnknownOwn) console.log(`messages skipped, own account not identified: ${dmSkippedUnknownOwn}`);
  if (dbUpdateFailures) console.log(`database updates failed after posting: ${dbUpdateFailures}`);
  if (limitHit) console.log('reply limit reached');
  if (postingStopped) console.log('posting stopped after repeated failures');
  return 0;
}

module.exports = { main };
if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => { console.error('Failed: ' + (e && /^Supabase \d+ on /.test(String(e.message)) ? e.message : (e && e.name) || 'error')); process.exit(1); });
}
