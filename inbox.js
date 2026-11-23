/* Cloverdale Paint dashboard: admin Inbox section.
   Loaded by applyRole() for admins only. Reads inbox_messages and reply_settings through
   the Supabase client already on the page (window.CP.sb). Renders into #inboxRoot. */
(function () {
  'use strict';
  if (window.__cpInboxLoaded) return;
  window.__cpInboxLoaded = true;

  var TZ = 'America/Vancouver';
  var REFRESH_MS = 5 * 60 * 1000;
  var ROW_LIMIT = 500;

  var CAT = {
    spam: 'Spam', complaint_high: 'Complaint (high priority)', complaint: 'Complaint', pr: 'Press or partnership',
    jobs: 'Jobs', store: 'Store question', price: 'Price', product: 'Product', colour: 'Colour', howto: 'How to',
    trade: 'Trade or dealer', praise: 'Praise', empty: 'Empty', none: 'Unclear', other_language: 'Other language',
    off_topic: 'Off-topic', general: 'General'
  };
  var CAT_ORDER = ['complaint_high', 'complaint', 'store', 'price', 'product', 'colour', 'howto', 'trade', 'jobs', 'pr', 'praise', 'general', 'off_topic', 'spam', 'other_language', 'empty', 'none'];
  var STATUS = {
    needs_person: ['Needs a person', 'var(--accent)'],
    replied: ['Replied', 'var(--good)'],
    would_reply: ['Would reply', 'var(--fb)'],
    no_reply: ['No reply', 'var(--muted)'],
    failed: ['Failed', 'var(--bad)'],
    'new': ['New', 'var(--gold)']
  };
  var STATUS_TABS = [['all', 'All'], ['needs_person', 'Needs a person'], ['replied', 'Replied'], ['would_reply', 'Would reply'], ['no_reply', 'No reply'], ['failed', 'Failed']];
  var PLAT = { instagram: 'Instagram', facebook: 'Facebook' };

  var S = {
    phase: 'loading',        // loading | ready | setup | error
    error: '',
    rows: [],
    settings: null,          // row of reply_settings, or null
    settingsErr: '',
    f: { plat: 'all', kind: 'all', status: 'all', cat: 'all', q: '' },
    confirm: false,
    saving: false,
    notice: '',
    busy: {},                // row id -> true while updating
    refreshing: false,
    timer: null,
    seq: 0
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function root() { return document.getElementById('inboxRoot'); }
  function $(sel, el) { return (el || root()).querySelector(sel); }
  function nowIso() { return new Date().toISOString(); }

  /* ---------- time (Vancouver) ---------- */
  var fmtParts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  var fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  function dayKey(d) { return fmtDay.format(d); }
  function when(iso) {
    if (!iso) return '\u2014';
    var d = new Date(iso); if (isNaN(d)) return '\u2014';
    var p = {}; fmtParts.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    var ap = String(p.dayPeriod || '').replace(/\./g, '').toLowerCase();
    var yr = String(d.getFullYear()) !== (new Date().getFullYear() + '') ? ', ' + p.year : '';
    return p.month.replace('.', '') + ' ' + p.day + yr + ', ' + p.hour + ':' + p.minute + ' ' + ap;
  }
  function safeUrl(u) {
    if (typeof u !== 'string') return '';
    var t = u.trim();
    return /^https?:\/\//i.test(t) ? t : '';
  }

  /* ---------- styles (scoped) ---------- */
  function injectCss() {
    if (document.getElementById('ibxCss')) return;
    var st = document.createElement('style'); st.id = 'ibxCss';
    st.textContent = V2_CSS + '\n' + [
      '#inboxRoot .ibx-top{margin-left:auto}',
      '#inboxRoot .ibx-gap{margin-top:18px}',
      '#inboxRoot .ibx-ctl{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}',
      '#inboxRoot .ibx-sw{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px;border:1px solid var(--line-2);border-radius:10px;background:var(--surface-2)}',
      '#inboxRoot .ibx-sw b{display:block;font-weight:600;font-size:13px}',
      '#inboxRoot .ibx-sw span{display:block;font-size:11.5px;color:var(--muted);margin-top:1px}',
      '#inboxRoot .sw-t:disabled{opacity:.5;cursor:progress}',
      '#inboxRoot .ibx-confirm{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:12px;padding:14px 16px;border-radius:12px;background:var(--accent-soft);border:1px solid var(--accent)}',
      '#inboxRoot .ibx-confirm p{margin:0;font-size:13px;color:var(--ink);flex:1 1 320px;line-height:1.5}',
      '#inboxRoot .ibx-confirm .ibx-acts{display:flex;gap:8px}',
      '#inboxRoot .ibx-warn{margin:0 0 12px;padding:10px 14px;border-radius:10px;background:var(--bad-soft);color:var(--bad);font-size:13px;display:flex;gap:10px;align-items:center;justify-content:space-between}',
      '#inboxRoot .ibx-warn button{border:0;background:none;color:inherit;font:inherit;font-weight:600;cursor:pointer;padding:0 2px}',
      '#inboxRoot .ibx-f{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}',
      '#inboxRoot .ibx-in{height:34px;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;padding:0 10px;font:inherit;font-size:13px;min-width:0}',
      '#inboxRoot .ibx-in:focus-visible{outline:2px solid var(--accent);outline-offset:1px}',
      '#inboxRoot .ibx-q{flex:1 1 200px;max-width:320px}',
      '#inboxRoot .ibx-n{color:var(--muted);font-size:12px;margin-left:auto}',
      '#inboxRoot .ibx-tbl td,#inboxRoot .ibx-tbl th{text-align:left;vertical-align:top}',
      '#inboxRoot .ibx-tbl td{font-family:var(--f);font-size:13px}',
      '#inboxRoot .ibx-tbl td.ibx-time{font-family:var(--fm);font-size:12px;color:var(--ink-2)}',
      '#inboxRoot .ibx-pl{white-space:nowrap}',
      '#inboxRoot .ibx-ty{display:block;font-size:11.5px;color:var(--muted);margin-top:4px}',
      '#inboxRoot .ibx-tbl td.ibx-time{white-space:normal;min-width:78px}',
      '#inboxRoot .ibx-tbl td.ibx-cu{white-space:normal;min-width:100px;max-width:130px;overflow-wrap:anywhere}',
      '#inboxRoot .ibx-tbl td.ibx-ct{white-space:normal;min-width:100px}',
      '#inboxRoot .ibx-tbl td.ibx-rp{min-width:140px;max-width:190px;white-space:normal}',
      '#inboxRoot .ibx-act{flex-direction:column;align-items:flex-start}',
      '#ibxStatus{display:block;max-width:100%;min-width:0}',
      '#inboxRoot .ibx-txt{white-space:normal;min-width:180px;max-width:260px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;line-height:1.45}',
      '#inboxRoot .ibx-rep{color:var(--ink-2)}',
      '#inboxRoot .ibx-err{color:var(--bad)}',
      '#inboxRoot .ibx-cat{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
      '#inboxRoot .ibx-act{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '#inboxRoot .ibx-act a{color:var(--ink);font-weight:600;font-size:12.5px;text-decoration:underline;text-underline-offset:2px}',
      '#inboxRoot tr.ibx-hi td:first-child{box-shadow:inset 3px 0 0 var(--bad)}',
      '#inboxRoot .ibx-run{margin:12px 0 0}',
      '@media (max-width:640px){',
      ' #inboxRoot .ibx-k .kpi:last-child:nth-child(odd){grid-column:1/-1}',
      ' #inboxRoot .ibx-top{margin-left:0}',
      ' #inboxRoot .ibx-q{max-width:none;flex-basis:100%}',
      ' #inboxRoot .ibx-n{margin-left:0;flex-basis:100%}',
      ' #inboxRoot .ibx-wrap{border:0;background:none;overflow:visible}',
      ' #inboxRoot .ibx-tbl,#inboxRoot .ibx-tbl tbody,#inboxRoot .ibx-tbl tr,#inboxRoot .ibx-tbl td{display:block}',
      ' #inboxRoot .ibx-tbl thead{display:none}',
      ' #inboxRoot .ibx-tbl tr{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:12px 14px;margin-bottom:10px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}',
      ' #inboxRoot .ibx-tbl td{padding:0 !important;border:0 !important;white-space:normal}',
      ' #inboxRoot .ibx-tbl td.ibx-time{order:1;flex:1 1 auto}',
      ' #inboxRoot .ibx-tbl td.ibx-pl{order:2}',
      ' #inboxRoot .ibx-ty{display:inline;margin:0 0 0 8px}',
      ' #inboxRoot .ibx-tbl td.ibx-empty{display:none}',
      ' #inboxRoot .ibx-act{flex-direction:row;align-items:center}',
      ' #inboxRoot .ibx-tbl td.ibx-cu{order:4;flex:1 1 100%;max-width:none;font-weight:600}',
      ' #inboxRoot .ibx-tbl td.ibx-ms{order:5;flex:1 1 100%}',
      ' #inboxRoot .ibx-tbl td.ibx-ct{order:6;min-width:0}',
      ' #inboxRoot .ibx-tbl td.ibx-st{order:7;margin-left:auto}',
      ' #inboxRoot .ibx-tbl td.ibx-rp{order:8;flex:1 1 100%;max-width:none;min-width:0;font-size:12.5px}',
      ' #inboxRoot .ibx-tbl td.ibx-ac{order:9;flex:1 1 100%}',
      ' #inboxRoot .ibx-txt{max-width:none;min-width:0;-webkit-line-clamp:4}',
      ' #inboxRoot tr.ibx-hi{box-shadow:inset 3px 0 0 var(--bad)}',
      ' #inboxRoot tr.ibx-hi td:first-child{box-shadow:none}',
      ' #inboxRoot .ibx-tbl tbody tr:hover td{background:none}',
      '}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ---------- derived data ---------- */
  function catLabel(c) { return CAT[c] || (c ? String(c) : 'Not sorted'); }
  function isHigh(r) { return r.priority === 'high' || r.category === 'complaint_high'; }
  function kpis() {
    var today = dayKey(new Date()), week = Date.now() - 7 * 864e5;
    var rec = 0, rep = 0, would = 0, need = 0, hi = 0;
    S.rows.forEach(function (r) {
      var t = r.received_at ? new Date(r.received_at) : null;
      var isToday = t && !isNaN(t) && dayKey(t) === today;
      if (isToday) rec++;
      if (r.status === 'replied' && (r.replied_at ? dayKey(new Date(r.replied_at)) === today : isToday)) rep++;
      if (r.status === 'would_reply' && isToday) would++;
      if (r.status === 'needs_person') need++;
      if (isHigh(r) && t && !isNaN(t) && t.getTime() >= week) hi++;
    });
    return { rec: rec, rep: rep, would: would, need: need, hi: hi };
  }
  function visible() {
    var f = S.f, q = f.q.trim().toLowerCase();
    return S.rows.filter(function (r) {
      if (f.plat !== 'all' && r.platform !== f.plat) return false;
      if (f.kind !== 'all' && r.kind !== f.kind) return false;
      if (f.status !== 'all' && r.status !== f.status) return false;
      if (f.cat !== 'all' && r.category !== f.cat) return false;
      if (q) {
        var hay = [r.text, r.author_name, r.reply_text, catLabel(r.category)].join(' \n ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }
  function isSetupError(e) {
    if (!e) return false;
    var m = String(e.message || '') + ' ' + String(e.details || '') + ' ' + String(e.hint || '');
    return e.code === '42P01' || e.code === 'PGRST205' || e.code === 'PGRST200' || e.status === 404 || /does not exist|schema cache|could not find the table|relation .* not/i.test(m);
  }

  /* ---------- rendering ---------- */
  function seg(id, label, opts, cur) {
    return '<div class="dseg" id="' + id + '" role="group" aria-label="' + esc(label) + '">' + opts.map(function (o) {
      return '<button type="button" data-v="' + esc(o[0]) + '" aria-pressed="' + (cur === o[0]) + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  function head() {
    return '<div class="sh nx-head"><h2>Inbox</h2><p>Comments and messages from Instagram and Facebook</p>' +
      '<button type="button" class="btn sm ibx-top" id="ibxRefresh"' + (S.refreshing ? ' disabled' : '') + '>' + (S.refreshing ? 'Refreshing\u2026' : 'Refresh') + '</button></div>';
  }
  function notice(icon, title, body, extra) {
    return '<div class="notice"><span class="ni">' + icon + '</span><div><b>' + esc(title) + '</b>' + (body ? '<p>' + esc(body) + '</p>' : '') + (extra || '') + '</div></div>';
  }

  function paintShell() {
    var el = root(); if (!el) return;
    if (S.phase === 'loading') {
      el.innerHTML = head() + notice('\u2026', 'Loading messages\u2026', '');
      bindHead(); return;
    }
    if (S.phase === 'setup') {
      el.innerHTML = head() + notice('!', 'Inbox is not set up yet.', 'The database tables for the inbox have not been created. Run the inbox setup once in Supabase, then refresh.');
      bindHead(); return;
    }
    if (S.phase === 'error') {
      el.innerHTML = head() + notice('!', 'The inbox could not be loaded', S.error, '<p style="margin-top:10px"><button type="button" class="btn sm" id="ibxRetry">Retry</button></p>');
      bindHead(); var rb = $('#ibxRetry'); if (rb) rb.onclick = function () { load(true); }; return;
    }
    el.innerHTML = head() +
      '<div id="ibxK"></div>' +
      '<div class="card ibx-gap" id="ibxC"></div>' +
      '<div class="card ibx-gap"><div class="card-h"><div><h3>Messages</h3><span class="sub">Latest ' + ROW_LIMIT + ', newest first. Times are Vancouver time.</span></div></div>' +
      '<div class="ibx-f nx-f">' + seg('ibxPlat', 'Platform', [['all', 'All platforms'], ['instagram', 'Instagram'], ['facebook', 'Facebook']], S.f.plat) +
      seg('ibxKind', 'Type', [['all', 'All types'], ['comment', 'Comments'], ['dm', 'Messages']], S.f.kind) + '</div>' +
      '<div class="ibx-f nx-f"><span id="ibxStatus"></span>' +
      '<select class="ibx-in" id="ibxCat" aria-label="Category"><option value="all">All categories</option>' + CAT_ORDER.map(function (c) { return '<option value="' + c + '"' + (S.f.cat === c ? ' selected' : '') + '>' + esc(CAT[c]) + '</option>'; }).join('') + '</select>' +
      '<input class="ibx-in ibx-q" id="ibxQ" type="search" placeholder="Search messages and customers" aria-label="Search" value="' + esc(S.f.q) + '"></div>' +
      '<div id="ibxL"></div></div>' +
      '<div class="card ibx-gap ibx-col" id="ibxTool"></div><div class="card ibx-gap ibx-col" id="ibxRules"></div>';
    bindHead(); bindFilters();
    paintKpis(); paintControls(); paintStatus(); paintList(); paintTool(); paintRules();
  }

  function paintKpis() {
    var el = $('#ibxK'); if (!el) return; var k = kpis();
    function c(l, v, n) { return '<div class="kpi"><div class="l">' + l + '</div><div class="v">' + v + '</div><div class="n">' + n + '</div></div>'; }
    el.innerHTML = '<div class="kpis nx-kpis ibx-k">' + c('Received today', k.rec, 'comments and messages') + c('Replied', k.rep, 'today') + c('Would reply', k.would, 'dry run, today') +
      c('Needs a person', k.need, 'open now') + c('High priority', k.hi, 'last 7 days') + '</div>';
  }

  function paintControls() {
    var el = $('#ibxC'); if (!el) return; var s = S.settings;
    var state = !s ? '' : (!s.replies_on ? '<span class="chip flat">Replies off</span>' : (s.dry_run ? '<span class="chip flat">Dry run</span>' : '<span class="chip">Replies live</span>'));
    var rows = [['replies_on', 'Replies', 'Master switch'], ['dry_run', 'Dry run', 'Sort and save, post nothing'], ['comments_on', 'Comments', 'Read post comments'], ['dms_on', 'Messages', 'Read direct messages']];
    var body;
    if (!s) {
      body = '<div class="ibx-warn" style="margin:0">' + esc(S.settingsErr || 'The settings row was not found.') + '</div>';
    } else {
      body = (S.confirm ? '<div class="ibx-confirm" role="alertdialog" aria-label="Confirm replies"><p><b>Switch replies on?</b> From now on the system answers new comments and messages that match a rule. Anything received before now is never answered. While Dry run is on, nothing is posted.</p><div class="ibx-acts"><button type="button" class="btn dark sm" id="ibxYes">Switch on</button><button type="button" class="btn sm" id="ibxNo">Cancel</button></div></div>' : '') +
        (S.notice ? '<div class="ibx-warn" role="alert"><span>' + esc(S.notice) + '</span><button type="button" id="ibxDismiss" aria-label="Dismiss">Dismiss</button></div>' : '') +
        '<div class="ibx-ctl">' + rows.map(function (r) {
          return '<label class="ibx-sw"><div><b>' + r[1] + '</b><span>' + r[2] + '</span></div><input type="checkbox" class="sw-t" data-k="' + r[0] + '"' + (s[r[0]] ? ' checked' : '') + (S.saving ? ' disabled' : '') + ' aria-label="' + r[1] + '"></label>';
        }).join('') + '</div>' +
        '<p class="note ibx-run">' + (s.last_run_at ? 'Last run ' + esc(when(s.last_run_at)) + (s.last_run_note ? ': ' + esc(s.last_run_note) : '') + '.' : 'The sync has not run yet.') +
        (s.switch_on_at ? ' Replies were first switched on ' + esc(when(s.switch_on_at)) + '.' : '') + '</p>';
    }
    el.innerHTML = '<div class="card-h"><div><h3>Auto-reply controls</h3><span class="sub">Changes apply from the next hourly run</span></div>' + state + '</div>' + body;
    var yes = $('#ibxYes'), no = $('#ibxNo'), dm = $('#ibxDismiss');
    if (yes) yes.onclick = function () { S.confirm = false; saveSettings({ replies_on: true, switch_on_at: nowIso() }); };
    if (no) no.onclick = function () { S.confirm = false; paintControls(); };
    if (dm) dm.onclick = function () { S.notice = ''; paintControls(); };
    Array.prototype.forEach.call(el.querySelectorAll('input[data-k]'), function (inp) {
      inp.onchange = function () { onToggle(inp.getAttribute('data-k'), inp.checked, inp); };
    });
  }

  function paintStatus() {
    var el = $('#ibxStatus'); if (!el) return;
    var counts = {}; S.rows.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
    el.innerHTML = seg('ibxSt', 'Status', STATUS_TABS.map(function (t) {
      return [t[0], t[1] + (t[0] === 'all' ? '' : (counts[t[0]] ? ' (' + counts[t[0]] + ')' : ''))];
    }), S.f.status);
    $('#ibxSt').onclick = function (e) { var b = e.target.closest('button'); if (b) { S.f.status = b.getAttribute('data-v'); paintStatus(); paintList(); } };
  }

  function paintList() {
    var el = $('#ibxL'); if (!el) return;
    var all = S.rows, rows = visible();
    if (!all.length) { el.innerHTML = '<div class="nx-empty"><b>No messages yet. The first sync fills this in.</b></div>'; return; }
    if (!rows.length) {
      el.innerHTML = '<div class="nx-empty"><b>No messages match these filters</b><span>Try a different status, category or search.</span><button type="button" class="btn sm" id="ibxClear" style="margin-top:8px">Clear filters</button></div>';
      $('#ibxClear').onclick = function () { S.f = { plat: 'all', kind: 'all', status: 'all', cat: 'all', q: '' }; paintShell(); };
      return;
    }
    el.innerHTML = '<div class="ibx-f" style="margin-bottom:8px"><span class="ibx-n" style="margin-left:0">' + rows.length + ' of ' + all.length + ' shown</span></div>' +
      '<div class="tbl-wrap ibx-wrap"><table class="t nx-tbl ibx-tbl"><thead><tr><th>Time</th><th>Source</th><th>Customer</th><th>Message</th><th>Category</th><th>Reply</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
      rows.map(rowHtml).join('') + '</tbody></table></div>';
    Array.prototype.forEach.call(el.querySelectorAll('button[data-handled]'), function (b) {
      b.onclick = function () { markHandled(b.getAttribute('data-handled')); };
    });
  }

  function rowHtml(r) {
    var st = STATUS[r.status] || [r.status || 'Unknown', 'var(--muted)'];
    var link = safeUrl(r.post_link);
    var reply;
    if (r.status === 'failed' && r.error) reply = '<span class="ibx-err">' + esc(r.error) + '</span>';
    else if (r.reply_text) reply = '<div class="ibx-txt ibx-rep" title="' + esc(r.reply_text) + '">' + esc(r.reply_text) + '</div>';
    else reply = '<span class="ibx-none" style="color:var(--muted)">\u2014</span>';
    var acts = '';
    if (link) acts += '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">Open post</a>';
    if (r.status === 'needs_person') acts += '<button type="button" class="btn sm" data-handled="' + esc(r.id) + '"' + (S.busy[r.id] ? ' disabled' : '') + '>' + (S.busy[r.id] ? 'Saving\u2026' : 'Mark handled') + '</button>';
    return '<tr' + (isHigh(r) ? ' class="ibx-hi"' : '') + '>' +
      '<td class="ibx-time">' + esc(when(r.received_at)) + '</td>' +
      '<td class="ibx-pl"><span class="nx-plat">' + esc(PLAT[r.platform] || r.platform) + '</span><span class="ibx-ty">' + (r.kind === 'dm' ? 'Message' : 'Comment') + '</span></td>' +
      '<td class="ibx-cu">' + (r.author_name ? esc(r.author_name) : '<span style="color:var(--muted)">Unknown</span>') + '</td>' +
      '<td class="ibx-ms"><div class="ibx-txt" title="' + esc(r.text) + '">' + esc(r.text) + '</div></td>' +
      '<td class="ibx-ct"><div class="ibx-cat"><span>' + esc(r.category === 'complaint_high' ? 'Complaint' : catLabel(r.category)) + '</span>' + (isHigh(r) ? '<span class="chip down">High priority</span>' : '') + '</div></td>' +
      '<td class="ibx-rp' + (reply.indexOf('ibx-none') >= 0 ? ' ibx-empty' : '') + '">' + reply + '</td>' +
      '<td class="ibx-st"><span class="nx-st" style="--c:' + st[1] + '"><i></i>' + esc(st[0]) + '</span></td>' +
      '<td class="ibx-ac"><div class="ibx-act">' + (acts || '<span style="color:var(--muted)">\u2014</span>') + '</div></td></tr>';
  }

  /* ---------- events ---------- */
  function bindHead() { var b = $('#ibxRefresh'); if (b) b.onclick = function () { load(true); }; }
  function bindFilters() {
    $('#ibxPlat').onclick = function (e) { var b = e.target.closest('button'); if (!b) return; S.f.plat = b.getAttribute('data-v'); setPressed('#ibxPlat', S.f.plat); paintList(); };
    $('#ibxKind').onclick = function (e) { var b = e.target.closest('button'); if (!b) return; S.f.kind = b.getAttribute('data-v'); setPressed('#ibxKind', S.f.kind); paintList(); };
    $('#ibxCat').onchange = function (e) { S.f.cat = e.target.value; paintList(); };
    $('#ibxQ').oninput = function (e) { S.f.q = e.target.value; paintList(); };
  }
  function setPressed(sel, v) {
    Array.prototype.forEach.call($(sel).querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === v)); });
  }

  function onToggle(k, on, inp) {
    if (S.saving) return;
    if (k === 'replies_on' && on && S.settings && !S.settings.switch_on_at) {
      inp.checked = false; S.confirm = true; paintControls(); return;
    }
    var patch = {}; patch[k] = on;
    saveSettings(patch);
  }

  function sbc() { return window.CP && window.CP.sb; }

  function saveSettings(patch) {
    var sb = sbc(); if (!sb) return;
    var body = Object.assign({}, patch, { updated_at: nowIso() });
    S.saving = true; S.notice = ''; paintControls();
    Promise.resolve(sb.from('reply_settings').update(body).eq('id', 1).select()).then(function (res) {
      S.saving = false;
      if (res && res.error) S.notice = 'The change was not saved: ' + (res.error.message || 'unknown error');
      else if (!res || !Array.isArray(res.data) || !res.data.length) S.notice = 'The change was not saved: no rows were updated (check admin access).';
      else Object.assign(S.settings, body);
      paintControls();
    }, function (e) {
      S.saving = false; S.notice = 'The change was not saved: ' + ((e && e.message) || 'network error'); paintControls();
    });
  }

  function markHandled(id) {
    var sb = sbc(); if (!sb || S.busy[id]) return;
    var row = S.rows.filter(function (r) { return String(r.id) === String(id); })[0]; if (!row) return;
    S.busy[id] = true; paintList();
    Promise.resolve(sb.from('inbox_messages').update({ status: 'no_reply' }).eq('id', row.id).select()).then(function (res) {
      delete S.busy[id];
      if (res && res.error) S.notice = 'Could not mark as handled: ' + (res.error.message || 'unknown error');
      else if (!res || !Array.isArray(res.data) || !res.data.length) S.notice = 'Could not mark as handled: no rows were updated (check admin access).';
      else row.status = 'no_reply';
      paintKpis(); paintControls(); paintStatus(); paintList();
    }, function (e) {
      delete S.busy[id]; S.notice = 'Could not mark as handled: ' + ((e && e.message) || 'network error');
      paintControls(); paintList();
    });
  }

  /* ---------- loading ---------- */
  function load(manual) {
    var sb = sbc(), el = root();
    if (!el) return Promise.resolve();
    if (!sb) { S.phase = 'error'; S.error = 'The database connection is not available. Reload the page.'; paintShell(); return Promise.resolve(); }
    var first = S.phase !== 'ready';
    var seq = ++S.seq;
    if (first) { S.phase = 'loading'; paintShell(); }
    else { S.refreshing = true; var b = $('#ibxRefresh'); if (b) { b.disabled = true; b.textContent = 'Refreshing\u2026'; } }
    var pm = Promise.resolve(sb.from('inbox_messages').select('*').order('received_at', { ascending: false }).limit(ROW_LIMIT));
    var ps = Promise.resolve(sb.from('reply_settings').select('*').limit(1));
    return Promise.all([pm, ps]).then(function (out) {
      if (seq !== S.seq) return;
      var m = out[0] || {}, s = out[1] || {};
      S.refreshing = false;
      if (isSetupError(m.error) || isSetupError(s.error)) { S.phase = 'setup'; paintShell(); return; }
      if (m.error) {
        if (!first) { S.notice = 'Refresh failed: ' + (m.error.message || 'unknown error'); S.phase = 'ready'; paintShell(); return; }
        S.phase = 'error'; S.error = m.error.message || 'Unknown error'; paintShell(); return;
      }
      S.rows = Array.isArray(m.data) ? m.data : [];
      if (s.error) { S.settings = null; S.settingsErr = 'Settings could not be loaded: ' + (s.error.message || 'unknown error'); }
      else if (!S.saving) { S.settings = (Array.isArray(s.data) ? s.data[0] : s.data) || null; S.settingsErr = ''; }
      S.phase = 'ready';
      if (first || !$('#ibxK')) paintShell();
      else { paintKpis(); paintControls(); paintStatus(); paintList(); var rb = $('#ibxRefresh'); if (rb) { rb.disabled = false; rb.textContent = 'Refresh'; } }
    }, function (e) {
      if (seq !== S.seq) return;
      S.refreshing = false;
      S.phase = 'error'; S.error = (e && e.message) || 'Network error'; paintShell();
    });
  }

  function start() {
    if (!root()) return Promise.resolve();
    injectCss();
    var p = load(false);
    if (S.timer) clearInterval(S.timer);
    S.timer = setInterval(function () {
      if (!root() || !root().isConnected) { clearInterval(S.timer); S.timer = null; return; }
      load(false);
    }, REFRESH_MS);
    return p;
  }

  /* ================= v2: Try a message + Reply rules ================= */
  var ACTION_W = { reply: 'Replies', no_reply: 'No reply', needs_person: 'Held for a person' };
  var RULE_LABEL = Object.assign({}, CAT, { deep: 'Long or detailed question', complaint_high: 'Complaint (high priority)' });
  var PH = ['name', 'locator', 'careers', 'catalog', 'product_search', 'colour_tools', 'sheen', 'howto', 'calculator', 'recycling', 'trade', 'industrial', 'dealer', 'store_name', 'store_address', 'store_hours', 'store_phone', 'store_url', 'city', 'page_title', 'page_url'];
  var ENGINE_SRC = 'scripts/reply-engine.js?v=2';
  var TL = { phase: 'idle', err: '', rules: [], stores: [], pages: [], act: null, p: null };   // shared data for both cards
  var T = { open: false, f: { text: '', platform: 'instagram', kind: 'comment', other: false, name: 'Alex' }, res: null };
  var R = { open: false, ed: null, notice: '', noticeKind: 'bad', busy: {} };

  function ruleLabel(c) { return RULE_LABEL[c] || String(c); }
  function activeRules() { if (!TL.act) TL.act = TL.rules.filter(function (r) { return r.active !== false; }); return TL.act; }
  function actionWords(r) { return (ACTION_W[r.action] || r.action) + (r.status_hint === 'needs_person' && r.action === 'reply' ? ' and flagged for a person' : ''); }
  function trunc(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n - 1) + '\u2026' : t; }

  function loadEngine() {
    return new Promise(function (resolve, reject) {
      if (window.CPReplyEngine && typeof window.CPReplyEngine.classify === 'function') return resolve();
      var s = document.getElementById('cpReplyEngineJs');
      if (!s) { s = document.createElement('script'); s.id = 'cpReplyEngineJs'; s.src = ENGINE_SRC; document.head.appendChild(s); }
      var done = false, tm;
      function fin(ok, e) {
        if (done) return; done = true; clearTimeout(tm);
        if (ok && window.CPReplyEngine && typeof window.CPReplyEngine.classify === 'function') resolve();
        else { if (s.parentNode) s.parentNode.removeChild(s); reject(e || new Error('engine missing')); }
      }
      s.addEventListener('load', function () { fin(true); });
      s.addEventListener('error', function () { fin(false, new Error('engine load failed')); });
      tm = setTimeout(function () { fin(false, new Error('engine timeout')); }, 8000);
    });
  }
  function loadData() {
    var sb = sbc(); if (!sb) return Promise.reject(new Error('The database connection is not available.'));
    function q(p) { return Promise.resolve(p).then(function (r) { if (r && r.error) throw Object.assign(new Error(isSetupError(r.error) ? 'The rules tables are not set up yet.' : (r.error.message || 'Unknown error')), { cp: 1 }); return (r && r.data) || []; }); }
    return Promise.all([
      q(sb.from('reply_rules').select('*').order('sort', { ascending: true }).limit(200)),
      q(sb.from('site_stores').select('*').limit(2000)),
      q(sb.from('site_pages').select('url,title,type,keywords').limit(5000))
    ]).then(function (o) {
      TL.rules = o[0].slice().sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
      TL.stores = o[1]; TL.pages = o[2]; TL.act = null;
    });
  }
  function ensureTools(force) {
    if (TL.phase === 'loading') return TL.p;
    if (TL.phase === 'ready' && !force) return Promise.resolve();
    TL.phase = 'loading'; TL.err = ''; paintTool(); paintRules();
    TL.p = Promise.all([
      loadEngine().then(function () { return null; }, function () { return 'engine'; }),
      loadData().then(function () { return null; }, function (e) { return (e && e.message) || 'Unknown error'; })
    ]).then(function (o) {
      if (o[0]) { TL.phase = 'engine'; }
      else if (o[1]) { TL.phase = 'data'; TL.err = o[1]; }
      else TL.phase = 'ready';
      paintTool(); paintRules();
    });
    return TL.p;
  }
  function toolsBody(open) {
    if (!open) return '';
    if (TL.phase === 'loading' || TL.phase === 'idle') return '<p class="note">Loading rules\u2026</p>';
    if (TL.phase === 'engine') return notice('!', 'Rules tools could not load', 'The rest of the inbox still works. Reload the page and try again.');
    if (TL.phase === 'data') return notice('!', 'Rules could not be loaded', TL.err, '<p style="margin-top:10px"><button type="button" class="btn sm" data-act="reload">Retry</button></p>');
    return null;
  }
  function cardHead(id, title, sub, open) {
    return '<div class="card-h"><div><h3>' + title + '</h3><span class="sub">' + sub + '</span></div><button type="button" class="btn sm" data-tog="' + id + '" aria-expanded="' + open + '">' + (open ? 'Close' : 'Open') + '</button></div>';
  }

  /* ----- Try a message ----- */
  function paintTool() {
    var el = $('#ibxTool'); if (!el) return;
    el.className = 'card ibx-gap' + (T.open ? '' : ' ibx-col');
    var h = cardHead('tool', 'Try a message', 'Check how a comment or message would be sorted and answered', T.open);
    var b = toolsBody(T.open);
    if (b === null) {
      var f = T.f, dm = f.kind === 'dm';
      b = '<div class="ibx-tf"><label class="ibx-fl ibx-wide"><b>Message</b><textarea class="ibx-in ibx-ta" id="ibxTMsg" rows="3" placeholder="Paste or type a customer message">' + esc(f.text) + '</textarea></label>' +
        '<label class="ibx-fl"><b>Platform</b><select class="ibx-in" id="ibxTPlat"><option value="instagram"' + (f.platform === 'instagram' ? ' selected' : '') + '>Instagram</option><option value="facebook"' + (f.platform === 'facebook' ? ' selected' : '') + '>Facebook</option></select></label>' +
        '<label class="ibx-fl"><b>Type</b><select class="ibx-in" id="ibxTKind"><option value="comment"' + (!dm ? ' selected' : '') + '>Comment</option><option value="dm"' + (dm ? ' selected' : '') + '>Message</option></select></label>' +
        '<label class="ibx-fl"><b>Author name</b><input class="ibx-in" id="ibxTName" type="text" value="' + esc(f.name) + '"></label>' +
        '<label class="ibx-ck"><input type="checkbox" class="sw-t" id="ibxTOther"' + (f.other && !dm ? ' checked' : '') + (dm ? ' disabled' : '') + '> Reply under another customer</label>' +
        '<div class="ibx-wide ibx-acts2"><button type="button" class="btn dark sm" id="ibxTGo">Check</button><button type="button" class="ibx-link" data-act="reload">Reload rules</button><span class="note" style="margin:0">' + activeRules().length + ' active rules, ' + TL.stores.length + ' stores, ' + TL.pages.length + ' pages</span></div></div>' +
        '<div id="ibxTRes" aria-live="polite"></div>';
    }
    el.innerHTML = h + b;
    if (T.open && TL.phase === 'ready') paintToolRes();
    el.onclick = function (e) {
      var t = e.target.closest('[data-tog],[data-act],#ibxTGo'); if (!t) return;
      if (t.getAttribute('data-tog')) toggleCard('tool');
      else if (t.getAttribute('data-act') === 'reload') ensureTools(true);
      else if (t.id === 'ibxTGo') runCheck();
    };
    el.oninput = function (e) { if (e.target.id === 'ibxTMsg') T.f.text = e.target.value; else if (e.target.id === 'ibxTName') T.f.name = e.target.value; };
    el.onchange = function (e) {
      var id = e.target.id;
      if (id === 'ibxTPlat') T.f.platform = e.target.value;
      else if (id === 'ibxTKind') { T.f.kind = e.target.value; paintTool(); }
      else if (id === 'ibxTOther') T.f.other = e.target.checked;
    };
  }
  function msgFor(f) {
    var dm = f.kind === 'dm';
    return { platform: f.platform, kind: dm ? 'dm' : 'comment', text: f.text, author_name: f.name, on_own_post: !dm, reply_to_other: !dm && !!f.other };
  }
  function ctxFor(rules) { return { rules: rules, links: (S.settings && S.settings.links) || {}, stores: TL.stores, pages: TL.pages, priorComplaint: false }; }
  function runCheck() {
    if (!window.CPReplyEngine) return;
    try { T.res = { r: window.CPReplyEngine.classify(msgFor(T.f), ctxFor(activeRules())) }; }
    catch (e) { T.res = { err: (e && e.message) || 'The check failed' }; }
    paintToolRes();
  }
  function paintToolRes() {
    var el = $('#ibxTRes'); if (!el) return; var x = T.res;
    if (!x) { el.innerHTML = ''; return; }
    if (x.err) { el.innerHTML = '<div class="ibx-warn" role="alert">' + esc(x.err) + '</div>'; return; }
    var r = x.r;
    el.innerHTML = '<div class="ibx-res"><div class="ibx-resh"><span class="ibx-cat"><b>' + esc(catLabel(r.category)) + '</b>' + (r.priority === 'high' ? '<span class="chip down">High priority</span>' : '') + '</span>' +
      '<span class="nx-st" style="--c:' + (r.action === 'reply' ? 'var(--good)' : (r.action === 'needs_person' ? 'var(--accent)' : 'var(--muted)')) + '"><i></i>' + esc(actionWords(r)) + '</span></div>' +
      (r.reply ? '<div class="ibx-reply">' + esc(r.reply) + '</div>' : '<div class="ibx-reply ibx-none">No reply text</div>') +
      '<p class="note" style="margin:8px 0 0">Rule: ' + esc(r.rule || '\u2014') + (r.pages_used ? ' \u00b7 Page used: ' + esc(r.pages_used) : '') + '</p></div>';
  }
  function toggleCard(which) {
    var o = which === 'tool' ? T : R; o.open = !o.open;
    if (o.open && TL.phase === 'idle') ensureTools(false); else { paintTool(); paintRules(); }
  }

  /* ----- Reply rules ----- */
  function kindOf(v) { return Array.isArray(v) ? 'array' : (typeof v === 'number' ? 'number' : (typeof v === 'boolean' ? 'bool' : 'other')); }
  function draftFrom(rule) {
    var d = { action: rule.action, active: rule.active !== false, t: {}, tk: [], p: {}, pk: [] };
    Object.keys(rule.triggers || {}).forEach(function (k) {
      var v = rule.triggers[k], ty = kindOf(v); d.tk.push(k);
      d.t[k] = { ty: ty, v: ty === 'array' ? v.join('\n') : (ty === 'other' ? v : (ty === 'number' ? String(v) : v)) };
    });
    Object.keys(rule.templates || {}).forEach(function (k) { d.pk.push(k); d.p[k] = String(rule.templates[k]); });
    return d;
  }
  function parseDraft(d) {
    var errs = [], out = { action: d.action, active: !!d.active, triggers: {}, templates: {} };
    if (['reply', 'no_reply', 'needs_person'].indexOf(d.action) < 0) errs.push('Choose an action.');
    d.tk.forEach(function (k) {
      var x = d.t[k], nm = k.replace(/_/g, ' ');
      if (x.ty === 'array') {
        var seen = {}, arr = [];
        String(x.v).split(/\r?\n/).forEach(function (l) { var w = l.trim().toLowerCase(); if (w && !seen[w]) { seen[w] = 1; arr.push(w); } });
        out.triggers[k] = arr;
      } else if (x.ty === 'number') {
        var s = String(x.v).trim(), n = Number(s);
        if (s === '' || !isFinite(n)) errs.push('"' + nm + '" must be a number.'); else out.triggers[k] = n;
      } else out.triggers[k] = x.v;
    });
    d.pk.forEach(function (k) {
      var t = String(d.p[k]).trim();
      if (!t) { errs.push('Template "' + k.replace(/_/g, ' ') + '" is empty.'); return; }
      var bad = [], re = /\{([^{}]*)\}/g, m;
      while ((m = re.exec(t))) { if (PH.indexOf(m[1]) < 0 && bad.indexOf(m[0]) < 0) bad.push(m[0]); }
      if (/[{}]/.test(t.replace(/\{[^{}]*\}/g, ''))) errs.push('Template "' + k.replace(/_/g, ' ') + '" has a stray brace.');
      if (bad.length) errs.push('Unknown placeholder ' + bad.join(', ') + ' in template "' + k.replace(/_/g, ' ') + '". Allowed: ' + PH.map(function (p) { return '{' + p + '}'; }).join(' '));
      out.templates[k] = t;
    });
    return { errs: errs, rule: out };
  }

  function paintRules() {
    var el = $('#ibxRules'); if (!el) return;
    el.className = 'card ibx-gap' + (R.open ? '' : ' ibx-col');
    var h = cardHead('rules', 'Reply rules', 'The words and reply templates the auto-reply uses', R.open);
    var b = toolsBody(R.open);
    if (b === null) {
      b = '<div id="ibxRN"></div><div class="ibx-rules">' + (TL.rules.length ? TL.rules.map(function (r) {
        var on = r.active !== false;
        return '<div class="ibx-rule' + (R.ed && R.ed.cat === r.category ? ' sel' : '') + '"><div class="ibx-rn"><b>' + esc(ruleLabel(r.category)) + '</b><span>' + esc(ACTION_W[r.action] || r.action) + '</span></div>' +
          '<label class="ibx-ck"><input type="checkbox" class="sw-t" data-active="' + esc(r.category) + '"' + (on ? ' checked' : '') + (R.busy[r.category] ? ' disabled' : '') + ' aria-label="Active: ' + esc(ruleLabel(r.category)) + '"><span>' + (on ? 'Active' : 'Off') + '</span></label>' +
          '<button type="button" class="btn sm" data-edit="' + esc(r.category) + '">Edit</button></div>';
      }).join('') : '<div class="nx-empty"><b>No rules found</b><span>Run the rules seed in Supabase first.</span></div>') + '</div><div id="ibxEd"></div>';
    }
    el.innerHTML = h + b;
    paintNotice(); paintEditor();
    el.onclick = function (e) {
      var t = e.target.closest('button'); if (!t) return;
      if (t.getAttribute('data-tog')) toggleCard('rules');
      else if (t.getAttribute('data-act') === 'reload') ensureTools(true);
      else if (t.getAttribute('data-edit')) openEditor(t.getAttribute('data-edit'));
      else edClick(t);
    };
    el.onchange = function (e) {
      var c = e.target.getAttribute && e.target.getAttribute('data-active');
      if (c) return saveActive(c, e.target.checked, e.target);
      edChange(e.target);
    };
    el.oninput = function (e) { edInput(e.target); };
  }
  function paintNotice() {
    var n = $('#ibxRN'); if (!n) return;
    n.innerHTML = R.notice ? '<div class="' + (R.noticeKind === 'ok' ? 'ibx-ok' : 'ibx-warn') + '" role="alert"><span>' + esc(R.notice) + '</span><button type="button" data-dismiss="1" aria-label="Dismiss">Dismiss</button></div>' : '';
  }
  function say(msg, kind) { R.notice = msg; R.noticeKind = kind || 'bad'; paintNotice(); }

  function saveActive(cat, on, inp) {
    var sb = sbc(), rule = TL.rules.filter(function (r) { return r.category === cat; })[0]; if (!sb || !rule || R.busy[cat]) return;
    R.busy[cat] = true; R.notice = ''; inp.disabled = true;
    var body = { active: on, updated_at: nowIso() };
    Promise.resolve(sb.from('reply_rules').update(body).eq('category', cat).select()).then(function (res) {
      delete R.busy[cat];
      if (res && res.error) { R.notice = 'Not saved: ' + (res.error.message || 'unknown error'); R.noticeKind = 'bad'; }
      else if (!res || !Array.isArray(res.data) || !res.data.length) { R.notice = 'Not saved (no permission?)'; R.noticeKind = 'bad'; }
      else { rule.active = on; rule.updated_at = body.updated_at; TL.act = null; R.notice = ''; }
      paintRules(); paintTool();
    }, function (e) { delete R.busy[cat]; R.notice = 'Not saved: ' + ((e && e.message) || 'network error'); R.noticeKind = 'bad'; paintRules(); });
  }

  function openEditor(cat) {
    var rule = TL.rules.filter(function (r) { return r.category === cat; })[0]; if (!rule) return;
    R.ed = { cat: cat, d: draftFrom(rule), stage: 'edit', errs: [], hist: { phase: 'loading', rows: [] }, replay: null, saving: false, note: '' };
    R.notice = ''; paintRules(); loadHistory(cat);
    var ed = $('#ibxEd'); if (ed && ed.scrollIntoView) ed.scrollIntoView({ block: 'nearest' });
  }
  function loadHistory(cat) {
    var sb = sbc(); if (!sb) return;
    Promise.resolve(sb.from('reply_rules_history').select('*').eq('category', cat).order('changed_at', { ascending: false }).limit(20)).then(function (res) {
      if (!R.ed || R.ed.cat !== cat) return;
      if (res && res.error) R.ed.hist = { phase: isSetupError(res.error) ? 'none' : 'err', rows: [], msg: res.error.message };
      else R.ed.hist = { phase: 'ready', rows: (res && res.data) || [] };
      paintHistory();
    }, function (e) { if (R.ed && R.ed.cat === cat) { R.ed.hist = { phase: 'err', rows: [], msg: e && e.message }; paintHistory(); } });
  }
  function paintEditor() {
    var el = $('#ibxEd'); if (!el) return; var E = R.ed;
    if (!E) { el.innerHTML = ''; return; }
    var rule = TL.rules.filter(function (r) { return r.category === E.cat; })[0] || {};
    var head = '<div class="card-h"><div><h3>' + (E.stage === 'replay' ? 'Check before saving: ' : 'Edit: ') + esc(ruleLabel(E.cat)) + '</h3><span class="sub">Rule key ' + esc(E.cat) + '. The order of rules cannot be changed here.</span></div><button type="button" class="btn sm" data-ed="close">Close</button></div>';
    if (E.stage === 'replay') { el.innerHTML = '<div class="ibx-edp">' + head + replayHtml(E) + '</div>'; return; }
    var d = E.d;
    var trig = d.tk.map(function (k) {
      var x = d.t[k], nm = k.replace(/_/g, ' '); nm = nm.charAt(0).toUpperCase() + nm.slice(1);
      if (x.ty === 'array') return '<label class="ibx-fl ibx-wide"><b>' + esc(nm) + '</b><span class="ibx-hint">One word or phrase per line. Lower-cased, blanks and duplicates are dropped when you check.</span><textarea class="ibx-in ibx-ta" rows="' + Math.max(3, Math.min(10, String(x.v).split('\n').length + 1)) + '" data-t="' + esc(k) + '">' + esc(x.v) + '</textarea></label>';
      if (x.ty === 'number') return '<label class="ibx-fl"><b>' + esc(nm) + '</b><input class="ibx-in" type="number" data-t="' + esc(k) + '" value="' + esc(x.v) + '"></label>';
      if (x.ty === 'bool') return '<label class="ibx-ck ibx-fl"><input type="checkbox" class="sw-t" data-t="' + esc(k) + '"' + (x.v ? ' checked' : '') + '> ' + esc(nm) + '</label>';
      return '<div class="ibx-fl"><b>' + esc(nm) + '</b><span class="ibx-hint">This setting is kept as it is.</span></div>';
    }).join('');
    var tpl = d.pk.map(function (k) {
      var nm = k.replace(/_/g, ' '); nm = nm.charAt(0).toUpperCase() + nm.slice(1);
      return '<label class="ibx-fl ibx-wide"><b>Template: ' + esc(nm) + '</b><textarea class="ibx-in ibx-ta" rows="3" data-p="' + esc(k) + '">' + esc(d.p[k]) + '</textarea></label>';
    }).join('');
    el.innerHTML = '<div class="ibx-edp">' + head + (E.note ? '<div class="ibx-ok" role="status"><span>' + esc(E.note) + '</span></div>' : '') +
      '<div class="ibx-tf"><label class="ibx-fl"><b>Action</b><select class="ibx-in" data-a="action">' + ['reply', 'no_reply', 'needs_person'].map(function (a) { return '<option value="' + a + '"' + (d.action === a ? ' selected' : '') + '>' + ACTION_W[a] + '</option>'; }).join('') + '</select></label>' +
      '<label class="ibx-ck ibx-fl"><input type="checkbox" class="sw-t" data-a="active"' + (d.active ? ' checked' : '') + '> Active</label>' + trig + tpl + '</div>' +
      (d.pk.length ? '<p class="ibx-hint" style="margin:6px 0 0">Allowed placeholders: ' + PH.map(function (p) { return '<code>{' + p + '}</code>'; }).join(' ') + '</p>' : '') +
      '<div id="ibxEErr">' + errHtml(E.errs) + '</div>' +
      '<div class="ibx-acts2" style="margin-top:12px"><button type="button" class="btn dark sm" data-ed="replay">Check against recent messages</button><button type="button" class="btn sm" data-ed="close">Close</button></div>' +
      '<div class="ibx-hist" id="ibxHist"></div></div>';
    paintHistory();
  }
  function errHtml(errs) { return errs && errs.length ? '<div class="ibx-warn" role="alert" style="margin-top:12px"><span>' + errs.map(esc).join('<br>') + '</span></div>' : ''; }
  function paintHistory() {
    var el = $('#ibxHist'); if (!el || !R.ed) return; var H = R.ed.hist;
    var b;
    if (H.phase === 'loading') b = '<p class="note">Loading history\u2026</p>';
    else if (H.phase === 'none') b = '<p class="note">History is not available yet.</p>';
    else if (H.phase === 'err') b = '<p class="note">History could not be loaded: ' + esc(H.msg || 'unknown error') + '</p>';
    else if (!H.rows.length) b = '<p class="note">No earlier versions yet. Each save keeps the previous version here.</p>';
    else b = '<div class="ibx-hl">' + H.rows.map(function (h, i) {
      var n = 0; Object.keys(h.triggers || {}).forEach(function (k) { if (Array.isArray(h.triggers[k])) n += h.triggers[k].length; });
      return '<div class="ibx-hr"><div><b>' + esc(h.change === 'delete' ? 'Deleted' : 'Edited') + '</b> <span class="ibx-hint">' + esc(when(h.changed_at)) + '</span><div class="ibx-hint">Version before the change: ' + esc(ACTION_W[h.action] || h.action || '') + ', ' + n + ' trigger phrases, ' + (h.active === false ? 'off' : 'active') + '</div></div><button type="button" class="btn sm" data-restore="' + i + '">Restore</button></div>';
    }).join('') + '</div>';
    el.innerHTML = '<h4 class="ibx-h4">History</h4>' + b;
  }

  function edInput(t) {
    var E = R.ed; if (!E || E.stage !== 'edit') return;
    var k = t.getAttribute && t.getAttribute('data-t'), p = t.getAttribute && t.getAttribute('data-p');
    if (k != null && E.d.t[k] && E.d.t[k].ty !== 'bool') E.d.t[k].v = t.value;
    else if (p != null) E.d.p[p] = t.value;
  }
  function edChange(t) {
    var E = R.ed; if (!E || E.stage !== 'edit' || !t.getAttribute) return;
    var k = t.getAttribute('data-t'), a = t.getAttribute('data-a');
    if (k != null && E.d.t[k] && E.d.t[k].ty === 'bool') E.d.t[k].v = t.checked;
    else if (a === 'action') E.d.action = t.value;
    else if (a === 'active') E.d.active = t.checked;
  }
  function edClick(t) {
    var E = R.ed;
    if (t.getAttribute('data-dismiss')) { R.notice = ''; paintNotice(); return; }
    if (!E) return;
    var ed = t.getAttribute('data-ed'), rs = t.getAttribute('data-restore');
    if (ed === 'close') { R.ed = null; paintRules(); }
    else if (ed === 'replay') startReplay();
    else if (ed === 'back') { E.stage = 'edit'; E.replay = null; paintEditor(); }
    else if (ed === 'save') saveRule();
    else if (rs != null) {
      var h = E.hist.rows[+rs]; if (!h) return;
      E.d = draftFrom({ action: h.action, active: h.active, triggers: h.triggers || {}, templates: h.templates || {} });
      E.errs = []; E.stage = 'edit'; E.replay = null; E.note = 'Version from ' + when(h.changed_at) + ' loaded. Review it, check it against recent messages, then save.';
      paintEditor();
      var top = $('#ibxEd'); if (top && top.scrollIntoView) top.scrollIntoView({ block: 'nearest' });
    }
  }

  function startReplay() {
    var E = R.ed, sb = sbc(); if (!E || !sb) return;
    var pr = parseDraft(E.d); E.errs = pr.errs;
    if (pr.errs.length) { var eb = $('#ibxEErr'); if (eb) eb.innerHTML = errHtml(pr.errs); return; }
    E.parsed = pr.rule; E.stage = 'replay'; E.replay = { phase: 'loading' }; paintEditor();
    var cat = E.cat;
    Promise.resolve(sb.from('inbox_messages').select('text,author_name,platform,kind,category').order('received_at', { ascending: false }).limit(200)).then(function (res) {
      if (!R.ed || R.ed.cat !== cat || R.ed.stage !== 'replay') return;
      if (res && res.error) { R.ed.replay = { phase: 'err', msg: res.error.message || 'unknown error' }; paintEditor(); return; }
      var rows = ((res && res.data) || []).filter(function (r) { return r && String(r.text == null ? '' : r.text).trim() !== ''; });
      R.ed.replay = Object.assign({ phase: 'ready' }, runReplay(rows, cat, R.ed.parsed)); paintEditor();
    }, function (e) { if (R.ed && R.ed.cat === cat) { R.ed.replay = { phase: 'err', msg: (e && e.message) || 'network error' }; paintEditor(); } });
  }
  function runReplay(rows, cat, edited) {
    var eng = window.CPReplyEngine, cur = activeRules();
    var base = TL.rules.filter(function (r) { return r.category !== cat; });
    var ed = Object.assign({}, TL.rules.filter(function (r) { return r.category === cat; })[0] || { category: cat }, edited, { category: cat });
    var next = base.concat([ed]).filter(function (r) { return r.active !== false; }).sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
    var cA = ctxFor(cur), cB = ctxFor(next), pairs = {}, ex = [], changed = 0;
    rows.forEach(function (r) {
      var dm = r.kind === 'dm';
      var m = { platform: r.platform, kind: dm ? 'dm' : 'comment', text: r.text, author_name: r.author_name, on_own_post: !dm, reply_to_other: false };
      var a, b;
      try { a = eng.classify(m, cA); b = eng.classify(m, cB); } catch (e) { return; }
      if (a.category !== b.category || a.action !== b.action || (a.reply || '') !== (b.reply || '')) {
        changed++;
        var key = catLabel(a.category) + '\u0001' + catLabel(b.category) + (a.category === b.category ? '\u0001same' : '');
        pairs[key] = (pairs[key] || 0) + 1;
        if (ex.length < 20) ex.push({ text: r.text, a: a, b: b });
      }
    });
    var list = Object.keys(pairs).map(function (k) { var p = k.split('\u0001'); return { from: p[0], to: p[1], same: p[2] === 'same', n: pairs[k] }; }).sort(function (x, y) { return y.n - x.n; });
    return { total: rows.length, changed: changed, pairs: list, examples: ex };
  }
  function replayHtml(E) {
    var Rp = E.replay || {};
    var btn = function (save) { return '<div class="ibx-acts2" style="margin-top:12px">' + (save ? '<button type="button" class="btn dark sm" data-ed="save"' + (E.saving ? ' disabled' : '') + '>' + (E.saving ? 'Saving\u2026' : (Rp.phase === 'err' ? 'Save without checking' : 'Save rule')) + '</button>' : '') + '<button type="button" class="btn sm" data-ed="back"' + (E.saving ? ' disabled' : '') + '>Back to editing</button></div>'; };
    var err = E.saveErr ? '<div class="ibx-warn" role="alert" style="margin-top:12px"><span>' + esc(E.saveErr) + '</span></div>' : '';
    if (Rp.phase === 'loading') return '<p class="note">Checking the last 200 messages\u2026</p>';
    if (Rp.phase === 'err') return '<div class="ibx-warn" role="alert"><span>The check could not run: ' + esc(Rp.msg) + '</span></div>' + err + btn(true);
    if (!Rp.total) return '<p class="note" style="margin:0">No stored messages to check against yet. You can still save.</p>' + err + btn(true);
    var sum = '<p class="ibx-sum"><b>' + Rp.changed + ' of ' + Rp.total + ' messages change</b> with this edit.</p>';
    var pairs = Rp.pairs.length ? '<ul class="ibx-pairs">' + Rp.pairs.map(function (p) { return '<li>' + esc(p.from) + ' \u2192 ' + esc(p.to) + (p.same ? ' (reply or action changes)' : '') + ': <b>' + p.n + '</b></li>'; }).join('') + '</ul>' : '';
    var ex = Rp.examples.length ? '<h4 class="ibx-h4">Examples' + (Rp.changed > Rp.examples.length ? ' (first ' + Rp.examples.length + ')' : '') + '</h4>' + Rp.examples.map(function (x) {
      function side(l, r) { return '<div><b>' + l + '</b> ' + esc(catLabel(r.category)) + ' \u00b7 ' + esc(actionWords(r)) + '<div class="ibx-exr">' + (r.reply ? esc(r.reply) : '<span class="ibx-hint">No reply text</span>') + '</div></div>'; }
      return '<div class="ibx-ex"><div class="ibx-exm">' + esc(trunc(x.text, 120)) + '</div><div class="ibx-exc">' + side('Now', x.a) + side('After edit', x.b) + '</div></div>';
    }).join('') : '';
    return sum + pairs + ex + err + btn(true);
  }
  function saveRule() {
    var E = R.ed, sb = sbc(); if (!E || !sb || E.saving) return;
    var pr = parseDraft(E.d); if (pr.errs.length) { E.stage = 'edit'; E.errs = pr.errs; paintEditor(); return; }
    var p = pr.rule, cat = E.cat;
    var body = { triggers: p.triggers, templates: p.templates, action: p.action, active: p.active, updated_at: nowIso() };
    E.saving = true; E.saveErr = ''; paintEditor();
    Promise.resolve(sb.from('reply_rules').update(body).eq('category', cat).select()).then(function (res) {
      if (!R.ed || R.ed.cat !== cat) return;
      E.saving = false;
      if (res && res.error) { E.saveErr = 'Not saved: ' + (res.error.message || 'unknown error'); paintEditor(); return; }
      if (!res || !Array.isArray(res.data) || !res.data.length) { E.saveErr = 'Not saved (no permission?)'; paintEditor(); return; }
      var rule = TL.rules.filter(function (r) { return r.category === cat; })[0];
      if (rule) { rule.triggers = body.triggers; rule.templates = body.templates; rule.action = body.action; rule.active = body.active; rule.updated_at = body.updated_at; }
      TL.act = null; R.ed = null; R.notice = 'Saved "' + ruleLabel(cat) + '". The previous version is kept in History.'; R.noticeKind = 'ok';
      paintRules(); paintTool();
    }, function (e) { E.saving = false; E.saveErr = 'Not saved: ' + ((e && e.message) || 'network error'); paintEditor(); });
  }

  var V2_CSS = [
    '#inboxRoot .ibx-col .card-h{margin-bottom:0}',
    '#inboxRoot .ibx-tf{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;align-items:end}',
    '#inboxRoot .ibx-wide{grid-column:1/-1}',
    '#inboxRoot .ibx-fl{display:grid;gap:5px;align-content:start}',
    '#inboxRoot .ibx-fl b{font-size:12.5px;font-weight:600}',
    '#inboxRoot .ibx-hint{font-size:11.5px;color:var(--muted)}',
    '#inboxRoot textarea.ibx-ta{height:auto;min-height:64px;padding:8px 10px;line-height:1.45;resize:vertical;width:100%;box-sizing:border-box;font-family:var(--f)}',
    '#inboxRoot .ibx-fl .ibx-in{width:100%;box-sizing:border-box}',
    '#inboxRoot .ibx-ck{display:flex;align-items:center;gap:10px;font-size:13px}',
    '#inboxRoot .ibx-acts2{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
    '#inboxRoot .ibx-link{border:0;background:none;color:var(--ink);font:inherit;font-size:12.5px;font-weight:600;text-decoration:underline;text-underline-offset:2px;cursor:pointer;padding:0}',
    '#inboxRoot .ibx-res{margin-top:14px;border:1px solid var(--line-2);border-radius:12px;padding:14px 16px;background:var(--surface-2)}',
    '#inboxRoot .ibx-resh{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}',
    '#inboxRoot .ibx-reply{margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--surface);border:1px solid var(--line);font-size:13px;line-height:1.5;overflow-wrap:anywhere;white-space:pre-wrap}',
    '#inboxRoot .ibx-reply.ibx-none{color:var(--muted)}',
    '#inboxRoot .ibx-rules{border:1px solid var(--line);border-radius:12px;overflow:hidden}',
    '#inboxRoot .ibx-rule{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line-2);flex-wrap:wrap}',
    '#inboxRoot .ibx-rule:last-child{border-bottom:0}',
    '#inboxRoot .ibx-rule.sel{background:var(--surface-2)}',
    '#inboxRoot .ibx-rn{flex:1 1 110px;min-width:0}',
    '#inboxRoot .ibx-rn b{display:block;font-weight:600;font-size:13px}',
    '#inboxRoot .ibx-rn span{font-size:12px;color:var(--muted)}',
    '#inboxRoot .ibx-edp{margin-top:16px;border:1px solid var(--line);border-radius:14px;padding:16px;background:var(--surface)}',
    '#inboxRoot .ibx-edp code{font-family:var(--fm);font-size:11px;background:var(--surface-2);border:1px solid var(--line-2);border-radius:5px;padding:1px 5px;white-space:nowrap}',
    '#inboxRoot .ibx-ok{margin:0 0 12px;padding:10px 14px;border-radius:10px;background:var(--good-soft);color:var(--good);font-size:13px;display:flex;gap:10px;align-items:center;justify-content:space-between}',
    '#inboxRoot .ibx-ok button{border:0;background:none;color:inherit;font:inherit;font-weight:600;cursor:pointer;padding:0 2px}',
    '#inboxRoot .ibx-h4{margin:18px 0 8px;font-size:13px;font-weight:650}',
    '#inboxRoot .ibx-hr{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--line-2);font-size:13px}',
    '#inboxRoot .ibx-hr:last-child{border-bottom:0}',
    '#inboxRoot .ibx-sum{margin:0 0 8px;font-size:14px}',
    '#inboxRoot .ibx-pairs{margin:0;padding-left:18px;font-size:13px;line-height:1.7}',
    '#inboxRoot .ibx-ex{border:1px solid var(--line-2);border-radius:10px;padding:10px 12px;margin-bottom:8px;background:var(--surface-2)}',
    '#inboxRoot .ibx-exm{font-size:13px;font-weight:600;overflow-wrap:anywhere;margin-bottom:8px}',
    '#inboxRoot .ibx-exc{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;font-size:12.5px}',
    '#inboxRoot .ibx-exr{margin-top:4px;color:var(--ink-2);overflow-wrap:anywhere;line-height:1.45}'
  ].join('\n');

  window.renderInbox = function () { return start(); };

  function boot() { if (window.CP && window.CP.role && window.CP.role !== 'admin') return; start(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
