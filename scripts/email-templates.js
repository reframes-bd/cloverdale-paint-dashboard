// Email templates for the Cloverdale social inbox (daily digest and alerts). v3: plain words and colour lights, phone and PC.
// Every email is multipart/alternative: a plain-text part (fallback) and a designed HTML part.
// HTML rules for email clients: tables for layout, inline styles only, no web fonts, no images, no scripts, max 600px.
'use strict';

const DASHBOARD_URL = 'https://reframes-bd.github.io/cloverdale-paint-dashboard/#sec-inbox';
const C = {
  page: '#F4F4F2', card: '#FFFFFF', ink: '#1A1A1A', ink2: '#555555', muted: '#6B6B6B', line: '#E6E6E3', soft: '#F7F7F5',
  accent: '#1A1A1A', urgent: '#B4232A', urgentSoft: '#FBF1F1', ok: '#2F7D55', bar: '#3A3A3A', barTrack: '#ECECE9', link: '#1F5FBF',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const CATEGORY = {
  complaint_high: 'Serious complaints', complaint: 'Complaints', pr: 'Collabs, PR and press', jobs: 'Jobs and careers',
  store: 'Store, hours and location', price: 'Prices and offers', product: 'Product questions', colour: 'Colour questions',
  howto: 'How-to and painting tips', trade: 'Trade and pro', praise: 'Praise and thanks', deep: 'Detailed questions',
  general: 'General (no specific rule)', off_topic: 'Off-topic (ignored)', empty: 'Emoji or tag only', spam: 'Spam',
  other_language: 'Other language', none: 'Not sorted',
};
const STATUS = {
  replied: 'Replied', would_reply: 'Would reply (dry run)', needs_person: 'Needs a person', no_reply: 'No reply needed',
  failed: 'Failed to post', new: 'Not processed yet', none: 'Unknown',
};
const catLabel = (k) => CATEGORY[k] || String(k || 'none').replace(/_/g, ' ');
const statusLabel = (k) => STATUS[k] || String(k || 'none').replace(/_/g, ' ');
const platformLabel = (p) => (p === 'facebook' ? 'Facebook' : p === 'instagram' ? 'Instagram' : 'Other');
const kindLabel = (k) => (k === 'dm' ? 'DM' : 'Comment');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const oneLine = (x) => String(x == null ? '' : x).replace(/\s*[\r\n]+\s*/g, ' ').trim();
const clip = (s, n) => { const t = oneLine(s); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const safeUrl = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : null);

// ---------- MIME ----------
function encodeHeader(v) {
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words = []; let cur = '';
  for (const ch of Array.from(v)) { if (Buffer.byteLength(cur + ch) > 42) { words.push(cur); cur = ''; } cur += ch; }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}
function fromHeader(mailFrom, name) {
  const f = oneLine(mailFrom);
  return /[<"]/.test(f) ? f : `"${name}" <${f}>`;
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
// text: plain-text body; html: full HTML document; urgent adds Importance headers
function buildMime({ from, to, subject, text, html, urgent, now }) {
  const boundary = `=_cp_${Number(now || Date.now()).toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const textAscii = /^[\x00-\x7f]*$/.test(text);
  const head = [`From: ${from}`, `To: ${oneLine(to)}`, `Subject: ${encodeHeader(subject)}`, `Date: ${new Date(now || Date.now()).toUTCString()}`, 'MIME-Version: 1.0'];
  if (urgent) head.push('Importance: high', 'X-Priority: 1');
  if (!html) {
    return head.concat(['Content-Type: text/plain; charset=UTF-8', `Content-Transfer-Encoding: ${textAscii ? '7bit' : 'base64'}`, '', textAscii ? text : b64(text), '']).join('\r\n');
  }
  return head.concat([`Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', `Content-Transfer-Encoding: ${textAscii ? '7bit' : 'base64'}`, '', textAscii ? text : b64(text), '',
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html), '',
    `--${boundary}--`, '']).join('\r\n');
}

// ---------- HTML building blocks ----------
// Design (v3, Nov 25 2026): plain words, colour lights, "what happened / what we did / what to do".
// Lights: green = done or fine, blue = information, amber = needs a person, red = urgent or broken, grey = left alone.
// Works on phone and PC: one fluid column (max 600px), tiles wrap 4 -> 2 per row, buttons go full width on small screens.
const L = {
  green: { dot: '#1E8E4E', bg: '#ECF7F0', ink: '#14633A' },
  blue: { dot: '#1F6FD1', bg: '#EDF3FC', ink: '#184F94' },
  amber: { dot: '#D98A00', bg: '#FDF5E4', ink: '#7A4D00' },
  red: { dot: '#C62828', bg: '#FCEDED', ink: '#9A1F1F' },
  grey: { dot: '#9A9A9A', bg: '#F3F3F1', ink: '#4A4A4A' },
};
const dot = (c, size) => `<span style="color:${L[c].dot};font-size:${size || 13}px;line-height:1;">&#9679;</span>`;

function shell({ preheader, top, body, footer }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(top)}</title>
<style>
@media only screen and (max-width:520px){
  .px{padding-left:18px !important;padding-right:18px !important}
  .tile{width:50% !important;max-width:none !important}
  .h1{font-size:21px !important;line-height:27px !important}
  .btn,.btn td{width:100% !important}
  .btn a{display:block !important;text-align:center !important}
  .hide-sm{display:none !important}
}
</style></head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:20px 8px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td class="px" style="padding:0 6px 10px 6px;font-family:${FONT};font-size:13px;color:${C.muted};"><b style="color:${C.ink};">Cloverdale Paint</b> &nbsp;·&nbsp; ${esc(top)}</td></tr>
<tr><td class="px" style="background:${C.card};border:1px solid ${C.line};border-radius:10px;padding:26px 28px 28px 28px;font-family:${FONT};color:${C.ink};">
${body}
</td></tr>
<tr><td class="px" style="padding:14px 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">${footer}</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}
// big coloured status box at the top
const banner = (c, head, sub) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="background:${L[c].bg};border-left:5px solid ${L[c].dot};border-radius:8px;padding:16px 18px;font-family:${FONT};">
<div class="h1" style="font-size:22px;line-height:28px;font-weight:700;color:${L[c].ink};">${dot(c, 16)}&nbsp; ${esc(head)}</div>
${sub ? `<div style="font-size:15px;line-height:22px;color:${C.ink};margin-top:6px;">${sub}</div>` : ''}</td></tr></table>`;
const h2 = (t) => `<div style="margin:28px 0 10px 0;font-size:13px;line-height:18px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;color:${C.muted};">${esc(t)}</div>`;
const p = (html, extra) => `<div style="margin:0;font-size:15px;line-height:23px;color:${C.ink};${extra || ''}">${html}</div>`;
const button = (href, label, color) => `<table role="presentation" class="btn" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;"><tr><td style="background:${color || C.ink};border-radius:8px;">
<a href="${esc(href)}" style="display:inline-block;padding:13px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;">${esc(label)}</a></td></tr></table>`;
const textLink = (href, label) => `<a href="${esc(href)}" style="color:${C.link};text-decoration:none;font-weight:600;">${esc(label)}</a>`;
const quote = (text) => `<div style="margin-top:8px;padding:10px 14px;background:${C.soft};border-radius:6px;font-size:15px;line-height:22px;color:${C.ink};">${esc(text)}</div>`;

// number tiles: 4 across on PC, 2 across on phone
function tiles(items) { // [{c, value, label}]
  const cell = (k) => `<div class="tile" style="display:inline-block;vertical-align:top;width:100%;max-width:134px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:4px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" height="66" style="height:66px;background:${L[k.c].bg};border-radius:8px;padding:12px 12px 13px 12px;font-family:${FONT};">
<div style="font-size:26px;line-height:30px;font-weight:700;color:${L[k.c].ink};">${esc(k.value)}</div>
<div style="font-size:13px;line-height:17px;color:${C.ink};margin-top:4px;">${dot(k.c, 10)}&nbsp; ${esc(k.label)}</div></td></tr></table>
</td></tr></table></div>`;
  return `<div style="font-size:0;line-height:0;margin:0 -4px;">
<!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><![endif]-->
${items.map((k) => `<!--[if mso]><td width="134" valign="top"><![endif]-->${cell(k)}<!--[if mso]></td><![endif]-->`).join('\n')}
<!--[if mso]></tr></table><![endif]--></div>`;
}
// one line with a light in front
const said = (c, html) => `<tr><td width="22" valign="top" style="padding:5px 0;font-size:13px;line-height:22px;">${dot(c)}</td><td style="padding:5px 0;font-family:${FONT};font-size:15px;line-height:22px;color:${C.ink};">${html}</td></tr>`;
const saidList = (lines) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${lines.join('')}</table>`;

const fmtDay = (ms, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(ms));
function fmtStamp(iso, tz) {
  const ms = Date.parse(iso || ''); if (Number.isNaN(ms)) return 'time unknown';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}
const where = (r) => `${platformLabel(r.platform)} ${r.kind === 'dm' ? 'message' : 'comment'}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const IGNORED = ['off_topic', 'empty', 'spam'];

// ---------- daily digest ----------
// d: { tz, period 'day'|'week', fromMs, toMs, rows, attention?, openCount?, prevCount, high, offTopic, waitingDms, byStatus, byCat, topWords, settings {replies_on, dry_run} }
function digestHtml(d) {
  const tz = d.tz;
  const daily = d.period !== 'week';
  const total = d.rows.length;
  const s = d.byStatus || {};
  const live = !!(d.settings && d.settings.replies_on && !d.settings.dry_run);
  const replied = s.replied || 0, ready = s.would_reply || 0, failed = s.failed || 0;
  const leftAlone = s.no_reply || 0;
  const need = d.openCount != null ? d.openCount : (s.needs_person || 0);
  const attention = (d.attention || d.rows.filter((r) => r.status === 'needs_person' || r.priority === 'high'))
    .sort((a, b) => (b.priority === 'high') - (a.priority === 'high') || Date.parse(b.received_at || 0) - Date.parse(a.received_at || 0));
  const urgentOpen = attention.filter((r) => r.priority === 'high').length;
  const day = fmtDay(d.toMs, tz);
  const span = daily ? 'last 24 hours' : 'this week';

  // 1. status light
  const status = urgentOpen ? banner('red', `${plural(Math.max(need, urgentOpen), 'message needs', 'messages need')} a person`, `${urgentOpen === 1 ? 'One is' : urgentOpen + ' are'} urgent. Details below.`)
    : need ? banner('amber', `${plural(need, 'message needs', 'messages need')} a person`, 'Details below. Everything else was handled.')
      : failed ? banner('red', `${plural(failed, 'reply', 'replies')} did not post`, 'Open the Inbox to check them.')
        : banner('green', 'All good', `Nothing needs you today.${live ? ' Replies are going out on their own.' : ''}`);

  // 2. what happened (numbers)
  const t = [
    { c: 'blue', value: total, label: 'New messages' },
    live ? { c: 'green', value: replied, label: 'Answered' } : { c: 'blue', value: ready, label: 'Ready to answer' },
    { c: need ? 'amber' : 'green', value: need, label: 'Need a person' },
    failed ? { c: 'red', value: failed, label: 'Did not post' } : { c: 'grey', value: leftAlone, label: 'Left alone' },
  ];

  // 3. needs you
  const shown = attention.slice(0, 5);
  const needsYou = shown.map((r) => {
    const c = r.priority === 'high' ? 'red' : 'amber';
    const link = safeUrl(r.post_link);
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;"><tr>
<td style="border:1px solid ${C.line};border-left:4px solid ${L[c].dot};border-radius:8px;padding:12px 14px;font-family:${FONT};">
<div style="font-size:15px;line-height:21px;font-weight:700;color:${C.ink};">${r.priority === 'high' ? `<span style="color:${L.red.ink};">Urgent · </span>` : ''}${esc(oneLine(r.author_name) || 'A customer')}</div>
<div style="font-size:13px;line-height:19px;color:${C.muted};margin-top:2px;">${esc(where(r))} · ${esc(fmtStamp(r.received_at, tz))}</div>
${quote(clip(r.text, 160) || 'No text (photo, sticker or attachment)')}
${link ? `<div style="margin-top:10px;font-size:14px;">${textLink(link, `Reply on ${platformLabel(r.platform)} →`)}</div>` : ''}</td></tr></table>`;
  }).join('') + (attention.length > shown.length ? p(`And ${attention.length - shown.length} more in the Inbox.`, `margin-top:10px;font-size:14px;color:${C.muted};`) : '');

  // 4. what we did, in plain words
  const did = [];
  if (live) did.push(said('green', replied ? `Answered ${plural(replied, 'message', 'messages')} automatically.` : 'No messages needed an automatic answer.'));
  else did.push(said('blue', `Prepared ${plural(ready, 'reply', 'replies')}. Test mode is on, so nothing was posted.`));
  if (failed) did.push(said('red', `${plural(failed, 'reply', 'replies')} did not post. They are marked "failed" in the Inbox.`));
  if (d.high) did.push(said('red', `Sent ${plural(d.high, 'urgent alert', 'urgent alerts')} by email.`));
  if (need) did.push(said('amber', `Passed ${plural(need, 'message', 'messages')} to a person${daily ? ' (still open from the last 7 days)' : ''}.`));
  const ign = IGNORED.reduce((n, k) => n + ((d.byCat || {})[k] || 0), 0);
  if (ign) did.push(said('grey', `Left ${ign} alone: chatter, emoji or spam.`));

  // 5. top topics (one line)
  const topics = Object.entries(d.byCat || {}).filter(([k]) => !IGNORED.includes(k) && k !== 'none').sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${esc(catLabel(k))} (${v})`).join(', ');

  const body = status
    + h2(`What happened · ${span}`) + tiles(t)
    + (shown.length ? h2('Needs you') + needsYou : '')
    + h2('What we did') + saidList(did)
    + (topics ? h2('People asked about') + p(topics) : '')
    + button(DASHBOARD_URL, 'Open the Inbox');

  return shell({
    preheader: need ? `${plural(need, 'message needs', 'messages need')} a person · ${total} new · ${day}` : `All good · ${total} new · ${day}`,
    top: `${daily ? 'Daily' : 'Weekly'} inbox update · ${day}`,
    body,
    footer: `${daily ? 'Sent every morning' : 'Sent every week'} by the Cloverdale Paint social dashboard. Vancouver time. Customer messages are visible to admins only.`,
  });
}

// ---------- alerts ----------
// a: { tz, row?, reason, system?: { title, text, light?, did?, todo? } }
function alertHtml(a) {
  const tz = a.tz;
  if (!a.row) {
    const sy = a.system || {};
    const c = sy.light || 'amber';
    const body = banner(c, sy.title || 'Auto-reply notice', '')
      + h2('What happened') + p(esc(sy.text || ''))
      + (sy.did ? h2('What we did') + saidList([said('blue', esc(sy.did))]) : '')
      + (sy.todo ? h2('What to do') + p(esc(sy.todo)) : '')
      + button(DASHBOARD_URL, 'Open the Inbox');
    return shell({ preheader: sy.text || '', top: 'Inbox notice', body, footer: 'Sent by the Cloverdale Paint social dashboard.' });
  }
  const r = a.row;
  const who = oneLine(r.author_name) || 'A customer';
  const link = safeUrl(r.post_link);
  const plat = platformLabel(r.platform);
  const what = r.kind === 'dm' ? `sent a ${plat} message` : `left a${plat === 'Instagram' ? 'n' : ''} ${plat} comment`;
  const did = r.status === 'replied' && r.reply_text ? said('green', `Replied automatically:${quote(oneLine(r.reply_text))}`)
    : r.status === 'would_reply' && r.reply_text ? said('blue', `Prepared a reply, not posted (test mode):${quote(oneLine(r.reply_text))}`)
      : said('grey', 'Nothing posted. We left this one for a person.');
  const body = banner('red', 'Needs a person', `${esc(a.reason)} · ${esc(fmtStamp(r.received_at, tz))}`)
    + h2('What happened') + p(`<b>${esc(who)}</b> ${esc(what)}:`) + quote(oneLine(r.text) || 'No text (photo, sticker or attachment)')
    + h2('What we did') + saidList([did])
    + h2('What to do') + p(`Reply to them on ${esc(plat)}${r.kind === 'dm' ? '' : ' under the post'}, then mark it handled in the Inbox.`)
    + (link ? button(link, `Reply on ${plat}`, L.red.dot) : button(DASHBOARD_URL, 'Open the Inbox', L.red.dot))
    + (link ? p(textLink(DASHBOARD_URL, 'Open the Inbox'), 'margin-top:14px;font-size:14px;') : '');
  return shell({
    preheader: `${a.reason}: ${clip(r.text, 90)}`,
    top: 'Urgent inbox alert',
    body,
    footer: `Sent by the Cloverdale Paint social dashboard. Replying to this email does not reach the customer.`,
  });
}

module.exports = { buildMime, fromHeader, encodeHeader, digestHtml, alertHtml, catLabel, statusLabel, esc, DASHBOARD_URL };
