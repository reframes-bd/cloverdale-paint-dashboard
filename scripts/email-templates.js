// Email templates for the Cloverdale social inbox (weekly digest and urgent alerts).
// Every email is multipart/alternative: a plain-text part (fallback) and a designed HTML part.
// HTML rules for email clients: tables for layout, inline styles only, no web fonts, no images, no scripts, max 600px.
'use strict';

const DASHBOARD_URL = 'https://reframes-bd.github.io/cloverdale-paint-dashboard/#sec-inbox';
const C = {
  page: '#EEF0F2', card: '#FFFFFF', ink: '#15171A', ink2: '#4A5158', muted: '#7A828A', line: '#E3E6E9',
  band: '#0E1012', bandInk: '#ECEEF0', bandMuted: '#9AA1A8',
  good: '#1E9E6A', goodSoft: '#E6F6EF', warn: '#C77A12', warnSoft: '#FDF3E3', bad: '#D2453B', badSoft: '#FCEBEA',
  ig: '#B65CD3', fb: '#3F8EFF', bar: '#20B3A1', barSoft: '#E4F6F3',
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
function shell({ preheader, eyebrow, title, subtitle, bandColor, body, footer }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td style="background:${bandColor || C.band};border-radius:14px 14px 0 0;padding:26px 30px 24px 30px;font-family:${FONT};">
<div style="font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:${C.bandMuted};font-weight:600;">${esc(eyebrow)}</div>
<div style="font-size:26px;line-height:32px;color:${C.bandInk};font-weight:700;margin-top:8px;">${esc(title)}</div>
${subtitle ? `<div style="font-size:15px;line-height:22px;color:${C.bandMuted};margin-top:6px;">${esc(subtitle)}</div>` : ''}
</td></tr>
<tr><td style="background:${C.card};border-radius:0 0 14px 14px;padding:8px 30px 30px 30px;font-family:${FONT};color:${C.ink};">
${body}
</td></tr>
<tr><td style="padding:18px 30px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};text-align:center;">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}
const section = (title, inner, note) => `<div style="margin-top:28px;">
<div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:${C.muted};font-weight:700;padding-bottom:8px;border-bottom:1px solid ${C.line};">${esc(title)}</div>
${note ? `<div style="font-size:13px;line-height:19px;color:${C.ink2};margin-top:10px;">${esc(note)}</div>` : ''}
${inner}</div>`;
const button = (href, label, color) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;margin:4px 8px 4px 0;"><tr><td style="background:${color || C.ink};border-radius:8px;">
<a href="${esc(href)}" style="display:inline-block;padding:11px 18px;font-family:${FONT};font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none;">${esc(label)}</a></td></tr></table>`;
const pill = (label, fg, bg) => `<span style="display:inline-block;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:600;color:${fg};background:${bg};">${esc(label)}</span>`;

function kpis(items) { // [{label, value, note, color}]
  const w = Math.floor(100 / items.length);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;"><tr>${items.map((k, i) =>
    `<td width="${w}%" valign="top" style="padding:${i ? '0 0 0 8px' : '0'};"><div style="border:1px solid ${C.line};border-radius:10px;padding:14px 12px;">
<div style="font-size:28px;line-height:32px;font-weight:700;color:${k.color || C.ink};">${esc(k.value)}</div>
<div style="font-size:12px;line-height:16px;color:${C.ink2};margin-top:4px;font-weight:600;">${esc(k.label)}</div>
${k.note ? `<div style="font-size:11px;line-height:15px;color:${C.muted};margin-top:3px;">${esc(k.note)}</div>` : ''}</div></td>`).join('')}</tr></table>`;
}
function bars(rows, total) { // [{label, value}]
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;">${rows.map((r) => {
    const pct = Math.max(2, Math.round((r.value / max) * 100));
    const share = total ? Math.round((r.value / total) * 100) : 0;
    return `<tr><td style="padding:6px 0;font-size:14px;line-height:18px;color:${C.ink};" width="44%">${esc(r.label)}</td>
<td style="padding:6px 8px;" width="42%"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${C.barSoft};border-radius:4px;height:10px;line-height:10px;font-size:0;">
<table role="presentation" width="${pct}%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${r.color || C.bar};border-radius:4px;height:10px;line-height:10px;font-size:0;">&nbsp;</td></tr></table></td></tr></table></td>
<td style="padding:6px 0;font-size:14px;color:${C.ink};text-align:right;font-weight:600;white-space:nowrap;" width="14%">${r.value}<span style="color:${C.muted};font-weight:400;font-size:12px;"> ${share}%</span></td></tr>`;
  }).join('')}</table>`;
}
const quote = (text) => `<div style="margin-top:8px;padding:12px 14px;background:${C.page};border-left:3px solid ${C.line};border-radius:4px;font-size:14px;line-height:20px;color:${C.ink};">${esc(text)}</div>`;
const fmtDate = (ms, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(ms));
function fmtStamp(iso, tz) {
  const ms = Date.parse(iso || ''); if (Number.isNaN(ms)) return 'time unknown';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}
const delta = (now, before) => { if (before == null) return ''; const d = now - before; return d === 0 ? 'same as last week' : `${d > 0 ? '+' : ''}${d} vs last week`; };

// ---------- weekly digest ----------
// d: { tz, fromMs, toMs, rows (this week), prevCount, high, offTopic, waitingDms, byStatus, byCat, topWords [[w,c]], settings {replies_on, dry_run, last_run_at} }
function digestHtml(d) {
  const tz = d.tz;
  const total = d.rows.length;
  const s = d.byStatus;
  const range = `${fmtDate(d.fromMs, tz)} to ${fmtDate(d.toMs, tz)}`;
  const live = d.settings && d.settings.replies_on && !d.settings.dry_run;
  const mode = live ? pill('Replies are LIVE', C.good, C.goodSoft) : pill('Dry run: nothing is posted yet', C.warn, C.warnSoft);
  const auto = (s.replied || 0) + (s.would_reply || 0);

  const attention = d.rows.filter((r) => r.status === 'needs_person' || r.priority === 'high')
    .sort((a, b) => (b.priority === 'high') - (a.priority === 'high') || Date.parse(b.received_at || 0) - Date.parse(a.received_at || 0));
  const shown = attention.slice(0, 8);
  const attentionHtml = shown.length ? shown.map((r) => {
    const link = safeUrl(r.post_link);
    return `<div style="border:1px solid ${r.priority === 'high' ? '#F2C4C0' : C.line};border-radius:10px;padding:14px 16px;margin-top:12px;${r.priority === 'high' ? `background:${C.badSoft};` : ''}">
<div>${r.priority === 'high' ? pill('Urgent', '#FFFFFF', C.bad) + ' ' : ''}${pill(platformLabel(r.platform) + ' ' + kindLabel(r.kind).toLowerCase().replace('dm', 'DM'), '#FFFFFF', r.platform === 'facebook' ? C.fb : C.ig)} ${pill(catLabel(r.category), C.ink2, C.page)}</div>
<div style="font-size:15px;font-weight:700;color:${C.ink};margin-top:10px;">${esc(oneLine(r.author_name) || 'A customer')} <span style="font-weight:400;color:${C.muted};font-size:13px;">· ${esc(fmtStamp(r.received_at, tz))}</span></div>
${quote(clip(r.text, 220) || '(no text: photo, sticker or attachment)')}
${link ? `<div style="margin-top:10px;font-size:13px;"><a href="${esc(link)}" style="color:${C.fb};text-decoration:none;font-weight:600;">Open the post</a></div>` : ''}</div>`;
  }).join('') + (attention.length > shown.length ? `<div style="font-size:13px;color:${C.ink2};margin-top:10px;">And ${attention.length - shown.length} more in the dashboard Inbox.</div>` : '')
    : `<div style="margin-top:12px;padding:14px 16px;border-radius:10px;background:${C.goodSoft};color:${C.good};font-size:14px;font-weight:600;">Nothing is waiting for a person this week.</div>`;

  const catRows = Object.entries(d.byCat).filter(([k]) => k !== 'off_topic' && k !== 'empty' && k !== 'spam').sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: catLabel(k), value: v, color: k === 'complaint_high' || k === 'complaint' ? C.bad : C.bar }));
  const ignored = (d.byCat.off_topic || 0) + (d.byCat.empty || 0) + (d.byCat.spam || 0);

  const plat = {}; for (const r of d.rows) { const k = `${platformLabel(r.platform)} ${r.kind === 'dm' ? 'DMs' : 'comments'}`; plat[k] = (plat[k] || 0) + 1; }
  const platRows = Object.entries(plat).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v, color: /^Facebook/.test(k) ? C.fb : C.ig }));

  const outcome = [['replied', C.good], ['would_reply', C.bar], ['needs_person', C.warn], ['no_reply', '#B8BDC3'], ['failed', C.bad]]
    .filter(([k]) => s[k]).map(([k, color]) => ({ label: statusLabel(k), value: s[k], color }));

  const words = d.topWords.length ? `<div style="margin-top:12px;">${d.topWords.map(([w, c]) =>
    `<span style="display:inline-block;margin:0 6px 8px 0;padding:6px 11px;border-radius:999px;background:${C.page};border:1px solid ${C.line};font-size:13px;color:${C.ink};">${esc(w)} <b style="color:${C.muted};font-weight:600;">${c}</b></span>`).join('')}</div>` : '';

  const intro = `<div style="font-size:16px;line-height:24px;color:${C.ink};margin-top:22px;">Hi all,</div>
<div style="font-size:15px;line-height:23px;color:${C.ink2};margin-top:8px;">Here is what came in on Instagram and Facebook this week, what the auto-reply handled, and what still needs a person.</div>
<div style="margin-top:12px;">${mode}</div>`;

  const body = intro
    + kpis([
      { label: 'Messages in', value: total, note: delta(total, d.prevCount) },
      { label: live ? 'Answered automatically' : 'Would be answered', value: auto, color: C.good, note: total ? `${Math.round((auto / total) * 100)}% of all` : '' },
      { label: 'Need a person', value: s.needs_person || 0, color: (s.needs_person || 0) ? C.warn : C.ink, note: d.waitingDms ? `${d.waitingDms} DM over 5 days` : 'none overdue' },
      { label: 'Urgent', value: d.high, color: d.high ? C.bad : C.ink, note: d.high ? 'alert emails sent' : 'none this week' },
    ])
    + section('Needs your attention', attentionHtml)
    + (catRows.length ? section('What people asked about', bars(catRows, total - ignored), `${ignored} more were off-topic, emoji-only or spam and were left alone.`) : '')
    + (outcome.length ? section('What the system did', bars(outcome, total)) : '')
    + (platRows.length ? section('Where it came from', bars(platRows, total)) : '')
    + (words ? section('Ideas for new rules', words, 'Most common words in messages that did not match any rule. If one keeps showing up, it may be worth a rule of its own.') : '')
    + `<div style="margin-top:30px;">${button(DASHBOARD_URL, 'Open the Inbox in the dashboard', C.ink)}</div>
<div style="font-size:15px;line-height:23px;color:${C.ink};margin-top:26px;">Thanks,<br>TJ</div>`;

  const footer = `Sent automatically every Monday by the Cloverdale Paint social dashboard.<br>Counts cover ${esc(range)} (Vancouver time). Customer messages are only shown to admins.`;
  return shell({
    preheader: `${total} messages, ${s.needs_person || 0} need a person, ${d.high} urgent. ${range}.`,
    eyebrow: 'Cloverdale Paint · Social inbox', title: 'Weekly inbox digest', subtitle: range, body, footer,
  });
}

// ---------- urgent alert ----------
// a: { tz, row?, reason (text), system?: {title, text} }
function alertHtml(a) {
  const tz = a.tz;
  let body;
  if (a.row) {
    const r = a.row;
    const link = safeUrl(r.post_link);
    const posted = r.status === 'replied' && r.reply_text;
    const prepared = r.status === 'would_reply' && r.reply_text;
    const replyBlock = posted ? `${pill('Posted', C.good, C.goodSoft)}${quote(oneLine(r.reply_text))}`
      : prepared ? `${pill('Prepared, not posted (dry run)', C.warn, C.warnSoft)}${quote(oneLine(r.reply_text))}`
        : `<div style="font-size:14px;color:${C.ink2};margin-top:6px;">Nothing was posted. A person needs to answer this one.</div>`;
    const row = (k, v) => `<tr><td style="padding:7px 0;font-size:13px;color:${C.muted};width:110px;vertical-align:top;">${esc(k)}</td><td style="padding:7px 0;font-size:14px;color:${C.ink};font-weight:600;">${v}</td></tr>`;
    body = `<div style="margin-top:22px;padding:14px 16px;border-radius:10px;background:${C.badSoft};border:1px solid #F2C4C0;">
<div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${C.bad};font-weight:700;">Why this needs you</div>
<div style="font-size:17px;line-height:24px;color:${C.ink};font-weight:700;margin-top:4px;">${esc(a.reason)}</div></div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;">
${row('Customer', esc(oneLine(r.author_name) || 'unknown'))}
${row('Where', `${pill(platformLabel(r.platform) + ' ' + kindLabel(r.kind).toLowerCase().replace('dm', 'DM'), '#FFFFFF', r.platform === 'facebook' ? C.fb : C.ig)}`)}
${row('When', esc(fmtStamp(r.received_at, tz)) + ' <span style="color:' + C.muted + ';font-weight:400;">Vancouver time</span>')}
${row('Category', esc(catLabel(r.category)))}
</table>
${section('They wrote', quote(oneLine(r.text) || '(no text: photo, sticker or attachment)'))}
${section('Our reply', replyBlock)}
<div style="margin-top:26px;">${button(DASHBOARD_URL, 'Open the Inbox', C.bad)}${link ? button(link, 'Open the post', C.ink) : ''}</div>
<div style="font-size:13px;line-height:19px;color:${C.ink2};margin-top:18px;">Please answer the customer directly, or mark it handled in the dashboard Inbox once someone has. Replies to this email go to the dashboard's sending address, not to the customer.</div>
<div style="font-size:12px;color:${C.muted};margin-top:14px;">Rule that matched: ${esc(r.rule || 'n/a')}</div>`;
  } else {
    body = `<div style="font-size:15px;line-height:23px;color:${C.ink};margin-top:22px;">${esc(a.system.text)}</div>
<div style="margin-top:22px;">${button(DASHBOARD_URL, 'Open the Inbox', C.ink)}</div>`;
  }
  const title = a.row ? 'A customer needs a person' : a.system.title;
  return shell({
    preheader: a.row ? `${a.reason}: ${clip(a.row.text, 90)}` : a.system.text,
    eyebrow: a.row ? 'Urgent · Cloverdale Paint social inbox' : 'Cloverdale Paint social inbox',
    title, subtitle: a.row ? `${platformLabel(a.row.platform)} ${kindLabel(a.row.kind).toLowerCase()} from ${oneLine(a.row.author_name) || 'a customer'}` : '',
    bandColor: a.row ? '#7A1F1A' : C.band, body,
    footer: 'Sent automatically by the Cloverdale Paint social dashboard when a message needs a person.',
  });
}

module.exports = { buildMime, fromHeader, encodeHeader, digestHtml, alertHtml, catLabel, statusLabel, esc, DASHBOARD_URL };
