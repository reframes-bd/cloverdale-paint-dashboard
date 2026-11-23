// Email templates for the Cloverdale social inbox (weekly digest and urgent alerts).
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
// Design: one neutral palette, red only for urgency, hierarchy from size and weight, no badges or emoji.
function shell({ preheader, title, kicker, body, footer, urgent }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td style="padding:0 4px 14px 4px;font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="font-size:14px;font-weight:700;color:${C.ink};letter-spacing:-0.1px;">Cloverdale Paint</td>
<td align="right" style="font-size:13px;color:${C.muted};">Social inbox</td></tr></table></td></tr>
<tr><td style="background:${C.card};border:1px solid ${C.line};border-top:3px solid ${urgent ? C.urgent : C.ink};border-radius:6px;padding:34px 36px 36px 36px;font-family:${FONT};color:${C.ink};">
${kicker ? `<div style="font-size:13px;font-weight:600;color:${urgent ? C.urgent : C.muted};margin-bottom:10px;">${esc(kicker)}</div>` : ''}
<h1 style="margin:0;font-size:26px;line-height:32px;font-weight:700;letter-spacing:-0.5px;color:${C.ink};">${esc(title)}</h1>
${body}
</td></tr>
<tr><td style="padding:20px 4px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}
const p = (html, extra) => `<p style="margin:16px 0 0 0;font-size:15px;line-height:24px;color:${C.ink2};${extra || ''}">${html}</p>`;
const section = (title, inner, note) => `<div style="margin-top:34px;">
<h2 style="margin:0;font-size:16px;line-height:22px;font-weight:700;letter-spacing:-0.2px;color:${C.ink};">${esc(title)}</h2>
${note ? `<div style="font-size:13px;line-height:20px;color:${C.muted};margin-top:4px;">${esc(note)}</div>` : ''}
${inner}</div>`;
const button = (href, label, color) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;"><tr><td style="background:${color || C.ink};border-radius:6px;">
<a href="${esc(href)}" style="display:inline-block;padding:12px 20px;font-family:${FONT};font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none;">${esc(label)}</a></td></tr></table>`;
const textLink = (href, label) => `<a href="${esc(href)}" style="color:${C.link};text-decoration:none;font-weight:600;">${esc(label)}</a>`;
const hr = `<div style="height:1px;line-height:1px;font-size:0;background:${C.line};margin-top:30px;">&nbsp;</div>`;

function stats(items) { // [{label, value, note, urgent}]
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px;border-top:1px solid ${C.line};border-bottom:1px solid ${C.line};"><tr>${items.map((k, i) =>
    `<td width="${Math.floor(100 / items.length)}%" valign="top" style="padding:18px 0 18px ${i ? '16px' : '0'};${i ? `border-left:1px solid ${C.line};` : ''}">
<div style="font-size:28px;line-height:32px;font-weight:700;letter-spacing:-0.6px;color:${k.urgent && k.value ? C.urgent : C.ink};">${esc(k.value)}</div>
<div style="font-size:13px;line-height:18px;color:${C.ink};margin-top:6px;font-weight:600;">${esc(k.label)}</div>
${k.note ? `<div style="font-size:12px;line-height:17px;color:${C.muted};margin-top:2px;">${esc(k.note)}</div>` : ''}</td>`).join('')}</tr></table>`;
}
function bars(rows, total) { // [{label, value, urgent}]
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">${rows.map((r) => {
    const pct = Math.max(2, Math.round((r.value / max) * 100));
    return `<tr><td style="padding:7px 12px 7px 0;font-size:14px;line-height:19px;color:${C.ink};" width="46%">${esc(r.label)}</td>
<td style="padding:7px 0;" width="40%"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${C.barTrack};height:6px;line-height:6px;font-size:0;border-radius:3px;">
<table role="presentation" width="${pct}%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${r.urgent ? C.urgent : C.bar};height:6px;line-height:6px;font-size:0;border-radius:3px;">&nbsp;</td></tr></table></td></tr></table></td>
<td style="padding:7px 0 7px 12px;font-size:14px;color:${C.ink};text-align:right;font-weight:600;white-space:nowrap;" width="14%">${r.value}${total ? `<span style="color:${C.muted};font-weight:400;"> · ${Math.round((r.value / total) * 100)}%</span>` : ''}</td></tr>`;
  }).join('')}</table>`;
}
const quote = (text, big) => `<div style="margin-top:12px;padding:2px 0 2px 16px;border-left:3px solid ${C.line};font-size:${big ? 17 : 15}px;line-height:${big ? 26 : 23}px;color:${C.ink};">${esc(text)}</div>`;
const meta = (parts) => `<div style="font-size:13px;line-height:19px;color:${C.muted};margin-top:4px;">${parts.filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ')}</div>`;
const fmtDate = (ms, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(new Date(ms));
const fmtYear = (ms, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(new Date(ms));
function fmtStamp(iso, tz) {
  const ms = Date.parse(iso || ''); if (Number.isNaN(ms)) return 'time unknown';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}
const delta = (now, before) => { if (before == null) return ''; const d = now - before; return d === 0 ? 'Same as last week' : `${d > 0 ? '+' : '−'}${Math.abs(d)} vs last week`; };
const where = (r) => `${platformLabel(r.platform)} ${r.kind === 'dm' ? 'DM' : 'comment'}`;

// ---------- weekly digest ----------
// d: { tz, fromMs, toMs, rows (this week), prevCount, high, offTopic, waitingDms, byStatus, byCat, topWords [[w,c]], settings {replies_on, dry_run} }
function digestHtml(d) {
  const tz = d.tz;
  const total = d.rows.length;
  const s = d.byStatus;
  const range = `${fmtDate(d.fromMs, tz)} – ${fmtDate(d.toMs, tz)}, ${fmtYear(d.toMs, tz)}`;
  const live = d.settings && d.settings.replies_on && !d.settings.dry_run;
  const auto = (s.replied || 0) + (s.would_reply || 0);
  const need = s.needs_person || 0;

  const attention = d.rows.filter((r) => r.status === 'needs_person' || r.priority === 'high')
    .sort((a, b) => (b.priority === 'high') - (a.priority === 'high') || Date.parse(b.received_at || 0) - Date.parse(a.received_at || 0));
  const shown = attention.slice(0, 8);
  const attentionHtml = shown.length ? shown.map((r, i) => {
    const link = safeUrl(r.post_link);
    return `<div style="padding:18px 0;${i ? `border-top:1px solid ${C.line};` : ''}">
<div style="font-size:15px;line-height:21px;font-weight:700;color:${C.ink};">${r.priority === 'high' ? `<span style="color:${C.urgent};">Urgent · </span>` : ''}${esc(oneLine(r.author_name) || 'A customer')}</div>
${meta([where(r), fmtStamp(r.received_at, tz), catLabel(r.category)])}
${quote(clip(r.text, 220) || 'No text (photo, sticker or attachment)')}
${link ? `<div style="margin-top:10px;font-size:13px;">${textLink(link, 'Open the post')}</div>` : ''}</div>`;
  }).join('') + (attention.length > shown.length ? p(`And ${attention.length - shown.length} more in the dashboard Inbox.`, 'font-size:13px;') : '')
    : p('Nothing is waiting for a person this week.', `color:${C.ok};font-weight:600;`);

  const catRows = Object.entries(d.byCat).filter(([k]) => !['off_topic', 'empty', 'spam'].includes(k)).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: catLabel(k), value: v, urgent: k === 'complaint_high' || k === 'complaint' }));
  const ignored = (d.byCat.off_topic || 0) + (d.byCat.empty || 0) + (d.byCat.spam || 0);
  const relevant = total - ignored;

  const plat = {}; for (const r of d.rows) { const k = `${platformLabel(r.platform)} ${r.kind === 'dm' ? 'DMs' : 'comments'}`; plat[k] = (plat[k] || 0) + 1; }
  const platRows = Object.entries(plat).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v }));
  const outcome = ['replied', 'would_reply', 'needs_person', 'no_reply', 'failed'].filter((k) => s[k]).map((k) => ({ label: statusLabel(k), value: s[k], urgent: k === 'failed' }));

  const lead = `${total} message${total === 1 ? '' : 's'} came in this week. ${live ? `${auto} were answered automatically` : `${auto} would have been answered automatically`}${need ? `, and ${need} need${need === 1 ? 's' : ''} a person` : ', and nothing needs a person'}.`;

  const body = p('Hi all,', `color:${C.ink};margin-top:22px;`)
    + p(esc(lead) + (live ? '' : ' Replies are still in dry run, so nothing has been posted to customers yet.'))
    + stats([
      { label: 'Messages', value: total, note: delta(total, d.prevCount) },
      { label: live ? 'Answered' : 'Would answer', value: auto, note: total ? `${Math.round((auto / total) * 100)}% of all` : '' },
      { label: 'Need a person', value: need, note: d.waitingDms ? `${d.waitingDms} DM over 5 days` : 'None overdue' },
      { label: 'Urgent', value: d.high, note: d.high ? 'Alert sent' : 'None', urgent: true },
    ])
    + section('Needs your attention', attentionHtml)
    + (catRows.length ? section('What people asked about', bars(catRows, relevant), `${relevant} on-topic messages. ${ignored} off-topic, emoji-only or spam were left alone.`) : '')
    + (outcome.length ? section('What the system did', bars(outcome, total)) : '')
    + (platRows.length ? section('Where it came from', bars(platRows, total)) : '')
    + (d.topWords.length ? section('Ideas for new rules', p(d.topWords.map(([w, c]) => `${esc(w)} <span style="color:${C.muted};">(${c})</span>`).join(', '), 'margin-top:10px;'),
      'Common words in messages no rule matched. A word that keeps coming back may deserve its own rule.') : '')
    + button(DASHBOARD_URL, 'Open the Inbox in the dashboard')
    + hr + p('Thanks,<br>TJ', `color:${C.ink};margin-top:22px;`);

  return shell({
    preheader: `${total} messages · ${need} need a person · ${d.high} urgent · ${range}`,
    kicker: `Weekly digest · ${range}`, title: 'Weekly inbox digest', body,
    footer: `Sent every Monday by the Cloverdale Paint social dashboard. Counts cover ${esc(range)}, Vancouver time. Customer messages are visible to admins only.`,
  });
}

// ---------- urgent alert ----------
// a: { tz, row?, reason (text), system?: {title, text} }
function alertHtml(a) {
  const tz = a.tz;
  if (!a.row) {
    return shell({
      preheader: a.system.text, kicker: 'Auto-reply notice', title: a.system.title,
      body: p(esc(a.system.text)) + button(DASHBOARD_URL, 'Open the Inbox'),
      footer: 'Sent by the Cloverdale Paint social dashboard.',
    });
  }
  const r = a.row;
  const who = oneLine(r.author_name) || 'A customer';
  const link = safeUrl(r.post_link);
  const reply = r.status === 'replied' && r.reply_text ? { state: 'Posted automatically', text: oneLine(r.reply_text) }
    : r.status === 'would_reply' && r.reply_text ? { state: 'Prepared, not posted (dry run)', text: oneLine(r.reply_text) }
      : { state: 'Nothing posted', text: null };
  const row = (k, v) => `<tr><td style="padding:9px 0;border-top:1px solid ${C.line};font-size:13px;color:${C.muted};width:120px;vertical-align:top;">${esc(k)}</td><td style="padding:9px 0;border-top:1px solid ${C.line};font-size:14px;line-height:20px;color:${C.ink};">${v}</td></tr>`;
  const what = r.kind === 'dm' ? `sent a ${platformLabel(r.platform)} direct message` : `left an ${platformLabel(r.platform)} comment`.replace('an Facebook', 'a Facebook');
  const body = p(`${esc(who)} ${esc(what)} that needs a personal reply from the team.`, 'margin-top:14px;')
    + section('What they wrote', quote(oneLine(r.text) || 'No text (photo, sticker or attachment)', true))
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;border-bottom:1px solid ${C.line};">
${row('Reason', `<b style="color:${C.urgent};">${esc(a.reason)}</b>`)}
${row('Where', esc(where(r)))}
${row('When', esc(fmtStamp(r.received_at, tz)) + ` <span style="color:${C.muted};">Vancouver</span>`)}
${row('Our reply', esc(reply.state))}
</table>`
    + (reply.text ? section(r.status === 'replied' ? 'Reply we posted' : 'Reply we prepared', quote(reply.text)) : '')
    + (link ? button(link, `Reply on ${platformLabel(r.platform)}`, C.urgent) : button(DASHBOARD_URL, 'Open the Inbox', C.urgent))
    + p(`${link ? `Or ${textLink(DASHBOARD_URL, 'Open the Inbox')} in the dashboard to see the full thread. ` : ''}Once someone has answered, mark it handled in the Inbox.`, 'font-size:13px;line-height:20px;');
  return shell({
    urgent: true,
    preheader: `${a.reason}: ${clip(r.text, 90)}`,
    kicker: `Needs a person · ${a.reason}`, title: `${who} needs a reply`, body,
    footer: `Reminder from the Cloverdale Paint social dashboard. Rule matched: ${esc(r.rule || 'n/a')}. Replying to this email does not reach the customer.`,
  });
}

module.exports = { buildMime, fromHeader, encodeHeader, digestHtml, alertHtml, catLabel, statusLabel, esc, DASHBOARD_URL };
