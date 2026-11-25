// Reply engine for the Cloverdale inbox auto-reply. Pure logic: no network, no env, no file access.
// Works in Node (require) and in the browser as a classic script (window.CPReplyEngine).
// classify(msg, ctx) sorts one comment or DM into a category and builds the reply text.
// msg = {platform, kind:'comment'|'dm', text, author_name, on_own_post?, reply_to_other?}
// ctx = {rules, links, stores, pages, priorComplaint}
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CPReplyEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ALLOWED_HOSTS = ['cloverdalepaint.com', 'instagram.com', 'facebook.com'];
  const EN_STOP = ['the', 'is', 'are', 'do', 'you', 'what', 'how', 'and', 'for', 'this', 'have', 'can'];
  const FR_WORDS = ['bonjour', 'merci', 'peinture', 'magasin', 'couleur', 'est-ce', 'vous', 'avec', 'pour', 'quelle', 'quel', 'ou est', "s'il vous"];
  const SCORE_STOP = new Set(('the and for are you your yours with this that these those have has had can could would should will just ' +
    'what which who whom whose when where why how does did not but from any get got use using our out about there their they them its was were ' +
    'like want need know some much many more also been into than then very really please thanks thank hello hey need ' +
    'one two too all see let ask may might must shall let our ours his her she him who yes').split(/\s+/));
  const GENERIC = new Set(['paint', 'paints', 'colour', 'color', 'cloverdale', 'product', 'products']);
  const QUESTION_WORDS = ['what', 'which', 'where', 'when', 'how', 'why', 'do you', 'does', 'can i', 'can you', 'could', 'is it', 'is this', 'are you', 'are there'];
  const PRE = ['in', 'at', 'near', 'to', 'from', 'around', 'the'];
  const POST = ['store', 'location', 'branch', 'bc', 'ab', 'on', 'sk', 'mb'];
  const GENERAL_Q_START = /^(?:what|which|where|when|how|why|who|can|could|do|does|is|are|will|would|should)(?![a-z0-9])/;
  const REQUEST_RE = /^(?:tell me|show me|looking for|i'?m looking for|i need|we need|need|any (?:recommendation|suggestion|advice)s?|recommend|suggest|info on|information on|details on)(?![a-z0-9])/;
  const QUESTIONISH = /(?<![a-z0-9])(?:i have a question|have a question|quick question|a question|need help|can you help|help me|i was wondering|wondering|inquir[a-z]*|enquir[a-z]*)(?![a-z0-9])/;
  const DM_INTENT = /(?<![a-z0-9])(?:question|questions|help|inquiry|enquiry|info|information|wondering|asking|advice|assist[a-z]*)(?![a-z0-9])/;
  const STORE_ASK = /(?<![a-z0-9])(?:what time|when do you|are you open|is the store|store hours|your hours)(?![a-z0-9])/;
  // weak store words that are also everyday words; alone they do not make a message relevant unless asked like a store question
  const EVERYDAY_WEAK = new Set(['open', 'opens', 'close', 'closes', 'closed', 'closing']);
  const YOU_RE = /(?<![a-z0-9])(?:you|your)(?![a-z0-9])/;
  const URL_RE = /(?:https?:\/\/|www\.)\S+/g;
  const FR_RE = FR_WORDS.map((w) => [w, null]);

  // ---------- text helpers ----------
  function normalize(text) {
    return String(text == null ? '' : text)
      .normalize('NFD').replace(/\p{M}+/gu, '')
      .replace(/[\u2018\u2019\u201B\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '\\s+');

  const phraseCache = new Map();
  function phraseRe(s) {
    let re = phraseCache.get(s);
    if (!re) { re = new RegExp('(?<![a-z0-9])' + escRe(s) + '(?![a-z0-9])'); phraseCache.set(s, re); }
    return re;
  }
  const trigCache = new Map();
  function trigRe(trig) {
    let re = trigCache.get(trig);
    if (re) return re;
    let t = normalize(trig);
    const prefix = t.endsWith('*');
    if (prefix) t = t.slice(0, -1);
    re = new RegExp('(?<![a-z0-9])' + escRe(t) + (prefix ? '[a-z0-9]*' : '(?![a-z0-9])'));
    trigCache.set(trig, re);
    return re;
  }
  for (const f of FR_RE) f[1] = phraseRe(f[0]);
  const EN_RE = EN_STOP.map((w) => phraseRe(w));
  const QUESTION_RE = QUESTION_WORDS.map((w) => phraseRe(w));

  function words(text) { return [...new Set(text.match(/[a-z]{3,}/g) || [])].filter((w) => !SCORE_STOP.has(w) && !GENERIC.has(w)); }
  // pure JS stable hash (FNV-1a), the same in Node and in the browser
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }

  function urlHosts(text) {
    const hosts = []; const re = /(?:https?:\/\/|www\.)([^\s/?#:]+)/g; let m;
    while ((m = re.exec(text))) hosts.push(m[1].replace(/[.,;)]+$/, ''));
    return hosts;
  }
  const hostAllowed = (h) => ALLOWED_HOSTS.some((d) => h === d || h.endsWith('.' + d) || h === 'www.' + d);

  function firstName(author) {
    const full = String(author || '').trim();
    if (!full) return 'there';
    const w = full.split(/\s+/)[0];
    if (!/^\p{L}+$/u.test(w) || w.length < 2 || w.length > 20) return 'there';
    if (w === w.toLowerCase() && !/\s/.test(full)) return 'there';
    return w.charAt(0).toUpperCase() + w.slice(1);
  }

  // ---------- compiled rules (cached on the rules array) ----------
  const rulesCache = new WeakMap();
  function sameSig(sig, rules) {
    if (sig.length !== rules.length) return false;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i], s = sig[i];
      if (s[0] !== r || s[1] !== r.triggers || s[2] !== r.templates || s[3] !== r.active) return false;
    }
    return true;
  }
  const EMPTY = Object.freeze({ rule: {}, lists: {}, m() { return []; } });
  function compileRules(rules) {
    if (!Array.isArray(rules)) return EMPTY;
    const hit = rulesCache.get(rules);
    if (hit && sameSig(hit.sig, rules)) return hit.c;
    const rule = {}, lists = {};
    for (const r of rules) {
      if (!r || r.active === false || rule[r.category]) continue; // an inactive row is skipped everywhere
      rule[r.category] = r;
      const L = lists[r.category] = {};
      for (const k of Object.keys(r.triggers || {})) {
        if (!Array.isArray(r.triggers[k])) continue;
        L[k] = r.triggers[k].filter(Boolean).map((t) => ({ t: normalize(t), re: trigRe(t) }));
      }
    }
    const c = {
      rule, lists,
      m(cat, key, text) {
        const l = lists[cat] && lists[cat][key]; const out = [];
        if (l) for (const x of l) if (x.re.test(text)) out.push(x.t);
        return out;
      },
    };
    rulesCache.set(rules, { sig: rules.map((r) => [r, r && r.triggers, r && r.templates, r && r.active]), c });
    return c;
  }
  const tpl = (rule, key) => (rule && rule.templates && typeof rule.templates[key] === 'string' ? rule.templates[key] : null);

  // ---------- stores (compiled per stores array) ----------
  const storesCache = new WeakMap();
  function compileStores(stores) {
    if (!Array.isArray(stores)) return { list: [], perCity: {} };
    const hit = storesCache.get(stores);
    if (hit && hit.n === stores.length) return hit.v;
    const list = stores.filter((s) => !/warehouse/i.test(String(s.name || ''))).map((s) => ({ s, nn: normalize(s.name), nc: normalize(s.city) }));
    const perCity = {}; for (const e of list) perCity[e.nc] = (perCity[e.nc] || 0) + 1;
    const v = { list, perCity };
    storesCache.set(stores, { n: stores.length, v });
    return v;
  }
  const ctxCache = new Map();
  // An ambiguous place name (also an everyday word or name) only counts with a place-like word beside it.
  function hasContext(text, nname) {
    let r = ctxCache.get(nname);
    if (!r) {
      const c = escRe(nname);
      r = [new RegExp('(?<![a-z0-9])(?:' + PRE.join('|') + ')\\s+' + c + '(?![a-z0-9])'),
        new RegExp('(?<![a-z0-9])' + c + '\\s+(?:' + POST.join('|') + ')(?![a-z0-9])'),
        new RegExp('(?<![a-z0-9])' + c + '\\s*,\\s*(?:bc|ab|on|sk|mb|qc|yk)(?![a-z0-9])')];
      ctxCache.set(nname, r);
    }
    return r[0].test(text) || r[1].test(text) || r[2].test(text);
  }
  function detectStores(textNoBrand, stores, ambiguous) {
    const amb = new Set((ambiguous || []).map(normalize));
    const { list, perCity } = compileStores(stores);
    const ok = (nn) => nn && phraseRe(nn).test(textNoBrand) && (!amb.has(nn) || hasContext(textNoBrand, nn));
    // full store names first (longest wins: "west kelowna" beats "kelowna"); a store named just
    // like its city is a city match when that city has other stores
    let nameHits = list.filter((e) => ok(e.nn) && !(e.nn === e.nc && perCity[e.nn] > 1));
    nameHits = nameHits.filter((e) => !nameHits.some((o) => o.nn !== e.nn && o.nn.includes(e.nn)));
    let cand;
    if (nameHits.length) cand = nameHits.map((e) => e.s);
    else cand = list.filter((e) => ok(e.nc)).map((e) => e.s);
    const cities = [...new Set(cand.map((s) => normalize(s.city)))];
    if (!cand.length) return { kind: 'none', stores: [] };
    if (cand.length === 1) return { kind: 'one', stores: cand, store: cand[0], city: cand[0].city };
    if (cities.length === 1) return { kind: 'many', stores: cand, city: cand[0].city };
    return { kind: 'multi', stores: cand };
  }

  // ---------- pages (compiled per pages array) ----------
  const pagesCache = new WeakMap();
  function compilePages(pages) {
    if (!Array.isArray(pages)) return {};
    const hit = pagesCache.get(pages);
    if (hit && hit.n === pages.length) return hit.v;
    const v = {};
    for (const p of pages) (v[p.type] = v[p.type] || []).push({ p, kw: new Set(String(p.keywords || '').toLowerCase().split(/\s+/).filter(Boolean)) });
    pagesCache.set(pages, { n: pages.length, v });
    return v;
  }
  function pageMatch(text, pages, type) {
    const list = compilePages(pages)[type];
    if (!list) return null;
    const mw = words(text);
    if (!mw.length) return null;
    let best = null, bs = 0, second = 0;
    for (const e of list) {
      let score = 0; for (const w of mw) if (e.kw.has(w)) score++;
      if (score > bs) { second = bs; bs = score; best = e.p; } else if (score > second) second = score;
    }
    if (!best || bs < 2 || second === bs) return null;
    return best;
  }

  // ---------- templates ----------
  // A missing name drops the ", {name}" form instead of writing "Thanks, there!"; "Hi {name}," becomes "Hi there,".
  function fill(t, vals) {
    if (t == null) return null;
    if (!vals.name || vals.name === 'there') t = t.replace(/,\s*\{name\}(?=\s*[!.?,])/g, '').replace(/\s\{name\}(?=[!.?])/g, '').replace(/\{name\}/g, 'there');
    return t.replace(/\{([a-z_]+)\}/g, (m, k) => (vals[k] != null && String(vals[k]).trim() !== '' ? String(vals[k]) : m));
  }

  function classify(msg, ctx) {
    msg = msg || {}; ctx = ctx || {};
    const C = compileRules(ctx.rules);
    const R = C.rule;
    const links = ctx.links || {};
    const raw = String(msg.text == null ? '' : msg.text);
    const text = normalize(raw);
    const kind = msg.kind === 'dm' ? 'dm' : 'comment';
    const name = firstName(msg.author_name);
    const baseVals = Object.assign({}, links, { name });
    const M = (cat, key) => C.m(cat, key, text);
    // REPLY BRAIN: a template may hold several versions separated by "||". One is chosen per message
    // (stable for the same message), skipping versions already used in this thread during this run (ctx.used).
    const used = ctx.used instanceof Set ? ctx.used : new Set();
    const picked = [];
    const seed = String(msg.id || msg.external_id || '') + '|' + text;
    const T = (rule, key) => {
      const all = tpl(rule, key);
      if (all == null) return null;
      if (all.indexOf('||') < 0) return all; // single version: keep it exactly (add-on lines start with a space)
      const vs = all.split('||').map((v) => v.trim()).filter(Boolean);
      if (vs.length <= 1) return vs[0] || null;
      const start = hash(seed + '|' + key) % vs.length;
      for (let i = 0; i < vs.length; i++) { const v = vs[(start + i) % vs.length]; if (!used.has(v)) { picked.push(v); return v; } }
      picked.push(vs[start]); return vs[start];
    };

    const result = (category, action, o) => Object.assign({ category, priority: 'normal', action, status_hint: null, reply: null, rule: '', pages_used: null }, o || {});
    // Finish a reply: resolve placeholders, enforce one url at most, else hand to a person.
    const finish = (category, rule, body, extra) => {
      const o = Object.assign({ priority: 'normal', status_hint: null, pages_used: null }, extra || {});
      if (body == null || /\{[a-z_]+\}/.test(body)) return result(category, 'needs_person', Object.assign(o, { rule: rule + ' (unresolved placeholder)' }));
      if ((body.match(/https?:\/\/\S+/g) || []).length > 1) return result(category, 'needs_person', Object.assign(o, { rule: rule + ' (more than one url)' }));
      return result(category, 'reply', Object.assign(o, { rule, reply: body, variants: picked.slice() }));
    };

    // 0a empty
    const bare = text.replace(URL_RE, ' ').replace(/@\S+/g, ' ');
    const letters = bare.match(/\p{L}/gu) || [];
    if (letters.length < 3) return result('empty', 'no_reply', { rule: 'empty: fewer than 3 letters' });

    // 0b other language
    const nonLatin = letters.filter((c) => !/[a-z]/.test(c)).length;
    const enHits = EN_RE.filter((re) => re.test(bare)).length;
    let frHits = 0;
    for (const [w, re] of FR_RE) { if (w === 'couleur' && enHits > 0) continue; if (re.test(bare)) frHits++; }
    if (nonLatin / letters.length > 0.3) return result('other_language', 'needs_person', { rule: 'other_language: non-Latin script' });
    if (frHits >= 2 && frHits > enHits) return result('other_language', 'needs_person', { rule: 'other_language: French' });

    // 1 spam
    if (R.spam) {
      const hit = M('spam', 'any').length > 0;
      const outside = R.spam.triggers && R.spam.triggers.has_outside_link && urlHosts(text).some((h) => !hostAllowed(h));
      if (hit || outside) return result('spam', 'no_reply', { rule: 'spam: ' + (hit ? 'trigger' : 'outside link') });
    }

    // version 2 (relevance gate and general replies) needs both rule rows; an old seed gets version 1 behaviour
    const v2 = !!(R.off_topic && R.general);
    const prCheck = () => {
      if (!R.pr) return null;
      if (M('pr', 'press').length) return result('pr', 'no_reply', { priority: 'high', rule: 'pr: press request' });
      return M('pr', 'any').length ? result('pr', 'no_reply', { rule: 'pr: trigger' }) : null;
    };
    if (v2) { const p = prCheck(); if (p) return p; }

    // lookups shared by the gate and the steps below
    const noBrand = text.replace(/@cloverdalepaint/g, ' ').replace(/cloverdale paints?/g, ' ');
    const det = detectStores(noBrand, ctx.stores, R.store && R.store.triggers && Array.isArray(R.store.triggers.ambiguous_cities) ? R.store.triggers.ambiguous_cities : []);
    const storeVals = () => {
      const s = det.store || {};
      return { store_name: s.name, store_address: s.address, store_hours: s.hours, store_phone: s.phone, store_url: s.url, city: det.city };
    };
    const storeUsable = det.kind === 'one' && det.store.phone && det.store.hours;
    const hasQ = raw.indexOf('?') >= 0;

    const complaintHits = M('complaint', 'any');
    const severeAlone = M('complaint_high', 'severe_alone');
    const severeWith = M('complaint_high', 'severe_with_complaint');
    let highWhy = null;
    if (severeAlone.length) highWhy = 'severe word';
    else if (severeWith.length && complaintHits.length) highWhy = 'severe word with complaint';
    else if (complaintHits.length && ctx.priorComplaint) highWhy = 'complaint after an earlier complaint';

    const jobsHit = M('jobs', 'any').length > 0;
    const storeHits = M('store', 'any');
    const priceHit = M('price', 'any').length > 0;
    const productAny = M('product', 'any');
    const dsHit = M('product', 'datasheet').length > 0;
    const availHit = M('product', 'availability').length > 0;
    const whichColour = M('colour', 'which_colour');
    const colourAny = M('colour', 'any').concat(whichColour);
    const howtoAny = M('howto', 'any');
    const tradeDI = M('trade', 'dealer').concat(M('trade', 'industrial'));
    const tradeAny = tradeDI.concat(M('trade', 'any'));
    const praiseHit = M('praise', 'any').length > 0;

    // weak store words alone ("close", "open", "store") only mean a store question when it is asked like one
    const storeWeak = new Set(((R.store && R.store.triggers && R.store.triggers.weak) || []).map(normalize));
    const weakOnly = storeHits.every((h) => storeWeak.has(h));
    const weakNotAsked = storeHits.length > 0 && weakOnly && det.kind === 'none' && !hasQ && !STORE_ASK.test(text);

    // RELEVANCE gate
    if (v2) {
      const topicHit = M('off_topic', 'topic').length > 0;
      const brandHit = M('off_topic', 'brand').length > 0;
      const pageRel = !!(pageMatch(text, ctx.pages, 'product') || pageMatch(text, ctx.pages, 'howto') || pageMatch(text, ctx.pages, 'colour'));
      const ruleHit = !!highWhy || severeAlone.length > 0 || complaintHits.length > 0 || jobsHit || (storeHits.length > 0 && (!weakNotAsked || storeHits.some((h) => !EVERYDAY_WEAK.has(h)))) || priceHit ||
        productAny.length > 0 || dsHit || availHit || colourAny.length > 0 || howtoAny.length > 0 || tradeAny.length > 0;
      const aToE = topicHit || brandHit || ruleHit || det.kind !== 'none' || pageRel;
      const maxW = Number(R.off_topic.triggers && R.off_topic.triggers.reaction_max_words) || 0;
      let relevant, why = 'no topic words';
      if (msg.reply_to_other === true) {
        relevant = brandHit || (hasQ && YOU_RE.test(text) && (topicHit || ruleHit || det.kind !== 'none' || pageRel));
        why = 'reply between followers';
      } else if (kind === 'dm') {
        relevant = aToE || hasQ || DM_INTENT.test(text);
      } else {
        const reaction = msg.on_own_post !== false && praiseHit && maxW > 0 && text.split(' ').filter(Boolean).length <= maxW;
        relevant = aToE || reaction;
      }
      if (!relevant) return result('off_topic', 'no_reply', { rule: 'off_topic: ' + why });
    }

    // 2 and 3 complaints
    const high = R.complaint_high, comp = R.complaint;
    const complaintReply = (rule) => {
      const t = (storeUsable ? T(rule, 'store') : null) || T(rule, 'locator');
      const where = storeUsable ? 'store template' : 'locator template';
      return { body: t ? fill(t, Object.assign({}, baseVals, storeUsable ? storeVals() : {})) : null, where };
    };
    if (highWhy && high) {
      const { body, where } = complaintReply(high);
      let b = body;
      const healthLine = T(high, 'health_line');
      const health = M('complaint_high', 'health').length > 0;
      if (b != null && health && healthLine) b += healthLine;
      return finish('complaint_high', `complaint_high: ${highWhy}, ${where}${health ? ', health line' : ''}`, b, { priority: 'high', status_hint: 'needs_person' });
    }
    if (complaintHits.length && comp) {
      const { body, where } = complaintReply(comp);
      return finish('complaint', `complaint: trigger, ${where}`, body, { status_hint: 'needs_person' });
    }

    // 4 pr (version 1 order: after the complaints)
    if (!v2) { const p = prCheck(); if (p) return p; }

    // 5 jobs
    if (R.jobs && jobsHit) return finish('jobs', 'jobs: trigger', T(R.jobs, 'default') && fill(T(R.jobs, 'default'), baseVals));

    // praise statement: before store, only when it is not a question
    // praise flavour: brand love, looks (colour or space), thanks for service, or a warm general thank-you
    const praiseKey = () => {
      if (R.praise && R.praise.templates && typeof R.praise.templates.warm === 'string') {
        if (M('praise', 'service').length) return 'service';
        if (M('praise', 'brand').length) return 'brand';
        if (M('praise', 'looks').length) return 'looks';
        return 'warm';
      }
      return 'v' + (1 + (hash(text) % 3));
    };
    if (R.praise && praiseHit && !hasQ && !QUESTION_RE.some((re) => re.test(text))) {
      const key = praiseKey();
      return finish('praise', 'praise: ' + key, T(R.praise, key) && fill(T(R.praise, key), baseVals));
    }

    // 6 store (also: a store or city named in a question, unless it is about price)
    if (R.store) {
      const cityQuestion = storeHits.length === 0 && det.kind !== 'none' && hasQ && !priceHit;
      if (storeHits.length || cityQuestion) {
        const skip = weakNotAsked || (weakOnly && det.kind === 'none' && (colourAny.length || productAny.length || howtoAny.length || tradeAny.length));
        if (!skip) {
          const hol = M('store', 'holiday').length > 0;
          let key, why;
          if (det.kind === 'one') { key = 'store'; why = 'one store, city matched'; }
          else if (det.kind === 'many') { key = 'many'; why = 'several stores in the city'; }
          else if (det.kind === 'multi') { key = 'locator'; why = 'more than one city named'; }
          else { key = 'locator'; why = 'no city'; }
          if (key === 'store' && !storeUsable) { key = 'locator'; why = 'store missing phone or hours'; }
          const t = T(R.store, key);
          let b = t && fill(t, Object.assign({}, baseVals, key === 'store' ? storeVals() : { city: det.city }));
          if (b != null && hol && T(R.store, 'holiday_line')) b += T(R.store, 'holiday_line');
          return finish('store', 'store: ' + why + (hol ? ', holiday line' : ''), b);
        }
      }
    }

    // 7 price
    if (R.price && priceHit) return finish('price', 'price: trigger', T(R.price, 'default') && fill(T(R.price, 'default'), baseVals));

    const deep = R.deep;
    const deepCheck = (category) => {
      if (!deep) return null;
      const dt = deep.triggers || {};
      const qm = (raw.match(/\?/g) || []).length;
      const nw = text.split(' ').filter(Boolean).length;
      const why = M('deep', 'any').length ? 'trigger' : (dt.min_question_marks && qm >= dt.min_question_marks) ? 'question marks' : (dt.max_words && nw > dt.max_words) ? 'long message' : null;
      if (!why) return null;
      const t = T(deep, 'default');
      return finish(category, `${category}: deep`, t && fill(t, baseVals), {});
    };

    // 8 product
    if (R.product) {
      const skipProduct = whichColour.length || M('colour', 'tools').length || M('colour', 'sheen').length || (howtoAny.length && !dsHit && !availHit) || tradeDI.length;
      // a statement ("Painting my kitchen this weekend!") is not a product question: let it fall through to praise or general
      const leadQ = text.replace(/^(?:@\S+\s*)+/, '');
      const pmRaw = skipProduct ? null : pageMatch(text, ctx.pages, 'product');
      const dtr = (deep && deep.triggers) || {};
      const longMsg = dtr.max_words && text.split(' ').filter(Boolean).length > dtr.max_words;
      const asking = hasQ || GENERAL_Q_START.test(leadQ) || QUESTIONISH.test(text) || REQUEST_RE.test(leadQ) || dsHit || availHit || kind === 'dm' || !!pmRaw || longMsg || M('deep', 'any').length > 0;
      const pm = asking ? pmRaw : null;
      if (!skipProduct && asking && (productAny.length || dsHit || pm)) {
        const d = deepCheck('product'); if (d) return d;
        const avail = availHit ? (T(R.product, 'availability_line') || '') : '';
        if (dsHit) return finish('product', 'product: datasheet', T(R.product, 'datasheet') && fill(T(R.product, 'datasheet'), baseVals));
        if (pm) {
          const t = T(R.product, 'page');
          return finish('product', 'product: page match' + (avail ? ', availability line' : ''), t && fill(t, Object.assign({}, baseVals, { page_title: pm.title, page_url: pm.url })) + avail, { pages_used: pm.url });
        }
        const t = T(R.product, 'catalog');
        return finish('product', 'product: catalog' + (avail ? ', availability line' : ''), t && fill(t, baseVals) + avail);
      }
    }

    // 9 colour
    if (R.colour && colourAny.length) {
      if (whichColour.length) return result('colour', 'needs_person', { rule: 'colour: asks which colour (not guessed)' });
      let key = null;
      if (M('colour', 'sheen').length) key = 'sheen';
      else if (M('colour', 'tools').length) key = 'tools';
      else if (M('colour', 'look').length) key = 'look';
      if (key) {
        if (key !== 'look') { const d = deepCheck('colour'); if (d) return d; }
        return finish('colour', 'colour: ' + key, T(R.colour, key) && fill(T(R.colour, key), baseVals));
      }
      // no look, sheen or tools word: a question goes to the store team, a statement continues down
      if (hasQ) { const t = T(R.deep, 'default'); return finish('colour', 'colour: question, store', t && fill(t, baseVals)); }
    }

    // 10 howto
    if (R.howto && howtoAny.length && !tradeDI.length) {
      const d = deepCheck('howto'); if (d) return d;
      let key = 'general';
      if (M('howto', 'calculator').length) key = 'calculator';
      else if (M('howto', 'recycling').length) key = 'recycling';
      else {
        const pm = pageMatch(text, ctx.pages, 'howto');
        if (pm) return finish('howto', 'howto: page match', T(R.howto, 'page') && fill(T(R.howto, 'page'), Object.assign({}, baseVals, { page_url: pm.url, page_title: pm.title })), { pages_used: pm.url });
      }
      return finish('howto', 'howto: ' + key, T(R.howto, key) && fill(T(R.howto, key), baseVals));
    }

    // 11 trade
    if (R.trade && tradeAny.length) {
      const d = deepCheck('trade'); if (d) return d;
      const key = M('trade', 'dealer').length ? 'dealer' : M('trade', 'industrial').length ? 'industrial' : 'trade';
      return finish('trade', 'trade: ' + key, T(R.trade, key) && fill(T(R.trade, key), baseVals));
    }

    // 12 praise (not a question)
    if (R.praise && praiseHit && !hasQ) {
      const key = praiseKey();
      return finish('praise', 'praise: ' + key, T(R.praise, key) && fill(T(R.praise, key), baseVals));
    }

    // general (version 2) or none (version 1)
    if (!v2) return result('none', 'needs_person', { rule: 'none: nothing matched' });
    if (M('general', 'negative').length || M('general', 'profanity').length) return result('general', 'needs_person', { rule: 'general: negative tone' });
    const lead = text.replace(/^(?:@\S+\s*)+/, '');
    const isQuestion = hasQ || GENERAL_Q_START.test(lead) || QUESTIONISH.test(text);
    if (isQuestion && praiseHit) return result('general', 'needs_person', { rule: 'general: question about the post' });
    // a weak store word that was not asked like a store question ('Surrey hours please') still goes to the store team
    const key = isQuestion || storeHits.length > 0 ? 'question' : 'comment';
    return finish('general', 'general: ' + key, T(R.general, key) && fill(T(R.general, key), baseVals));
  }

  return { normalize, classify, firstName };
});
