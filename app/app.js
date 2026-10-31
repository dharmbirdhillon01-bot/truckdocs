/* TruckDocs — Phase 1 steps 5–7: accounts, trucks/trailers, and sending paperwork.
 * Every permission is enforced by the database (Row Level Security + server functions).
 * This screen code only shows what the server allows and reports what the server says.
 * It never shows success before the server confirms it. */
(() => {
'use strict';
const CFG = window.TD_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
const RETURN_URL = location.origin + location.pathname;
// Invite links: <app>/?invite=CODE. The code is kept on this phone until the driver has joined.
// It is only a convenience: the server still checks the code (one use, 7-day expiry) when joining.
const INVITE_KEY = 'td_invite';
const keep = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } } };
const pendingInvite = () => keep.get(INVITE_KEY)
  || (S.session && S.session.user.user_metadata && S.session.user.user_metadata.invite) || '';
const inviteLink = code => RETURN_URL + '?invite=' + encodeURIComponent(code);

/* ---------------- translations (English always shown) ---------------- */
const SECOND = { 'en': null, 'en-pa': 'pa', 'en-hi': 'hi', 'en-fr': 'fr' };
const I18N = { en: {} };
let lang = localStorage.getItem('td_lang') || 'en';
async function loadLang(code) {
  if (!code || I18N[code]) return;
  try { const r = await fetch(`i18n/${code}.json`, { cache: 'no-cache' }); I18N[code] = r.ok ? await r.json() : {}; }
  catch { I18N[code] = {}; }
}
const tx = k => I18N.en[k] || k;
function L(k) {
  const second = SECOND[lang] && I18N[SECOND[lang]] && I18N[SECOND[lang]][k];
  return esc(tx(k)) + (second ? `<span class="l2">${esc(second)}</span>` : '');
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- state ---------------- */
const S = { view: 'loading', session: null, profile: null, memberships: [], company: null, team: [],
            msg: null, busy: false, inviteCode: null, confirmUser: null, roleChoice: null,
            vehicles: [], editVehicle: null, confirmRetire: null, showRetired: false, showRemoved: false, pick: {}, unitAction: {},
            docs: [], send: null, files: {}, openDoc: null, docFilter: 'all', truckFilter: 'all', showTrash: false, confirmTrash: null, daddKind: null,
            dpick: (() => { try { return JSON.parse(localStorage.getItem('td_dpick')) || {}; } catch { return {}; } })() };
const setMsg = (kind, text) => { S.msg = text ? { kind, text } : null; };
function friendly(err) {
  const m = (err && (err.message || err.error_description)) || tx('error_generic');
  if (/Invalid login credentials/i.test(m)) return 'Email or password is not correct.';
  if (/Email not confirmed/i.test(m)) return 'Please confirm your email first. Check your inbox for the link.';
  if (/rate limit/i.test(m)) return 'Too many emails sent in a short time. Please wait a few minutes and try again.';
  if (/vehicles_company_id_kind_unit_number_key|duplicate key/i.test(m)) return tx('unit_exists');
  if (/missing email/i.test(m)) return 'Please type your email.';
  return m;
}

/* ---------------- data loading ---------------- */
async function loadContext() {
  const uid = S.session.user.id;
  const [{ data: prof, error: e1 }, { data: mems, error: e2 }] = await Promise.all([
    sb.from('profiles').select('user_id, full_name, language').eq('user_id', uid).maybeSingle(),
    sb.from('memberships').select('company_id, role, active, companies(name)').eq('user_id', uid),
  ]);
  if (e1 || e2) throw (e1 || e2);
  S.profile = prof; S.memberships = mems || [];
  if (prof && prof.language && prof.language !== lang) { lang = prof.language; localStorage.setItem('td_lang', lang); await loadLang(SECOND[lang]); }
  const active = S.memberships.find(m => m.active);
  S.company = active ? { id: active.company_id, name: active.companies && active.companies.name, role: active.role } : null;
  if (S.company) {
    await loadVehicles();                                   // drivers can see units (database allows read only)
    if (S.company.role === 'owner') await loadTeam();
    await loadDocs();
  }
  S.view = S.company ? 'home' : (S.memberships.some(m => !m.active) ? 'removed' : 'onboard');
  if (S.view === 'onboard' && pendingInvite()) S.roleChoice = 'driver';
}
async function loadVehicles() {
  const { data, error } = await sb.from('vehicles').select('id, kind, unit_number, active')
    .eq('company_id', S.company.id).order('unit_number');
  if (error) throw error;
  // numbers in natural order: 9 before 10
  S.vehicles = (data || []).sort((a, b) => a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true }));
}
// Papers. Owners get every paper in the company; drivers get only their own (the database decides this, not the app).
async function loadDocs() {
  let q = sb.from('documents')
    .select('id, type, truck_id, trailer_id, details, created_by, created_at, current_version, verification, verified_at, trashed_at, document_versions(version_no, storage_path, mime_type, size_bytes)')
    .eq('company_id', S.company.id);
  q = S.showTrash ? q.not('trashed_at', 'is', null) : q.is('trashed_at', null);   // the trash shows only trashed papers
  const { data, error } = await q.order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  S.docs = (data || []).map(d => {
    const vs = (d.document_versions || []).sort((a, b) => b.version_no - a.version_no);
    return { ...d, file: vs[0] || null };
  });
}
async function loadTeam() {
  const { data: mems, error } = await sb.from('memberships').select('user_id, role, active, created_at')
    .eq('company_id', S.company.id).order('created_at');
  if (error) throw error;
  const ids = mems.map(m => m.user_id);
  const { data: profs, error: e2 } = await sb.from('profiles').select('user_id, full_name').in('user_id', ids);
  if (e2) throw e2;
  const names = Object.fromEntries((profs || []).map(p => [p.user_id, p.full_name]));
  S.team = mems.map(m => ({ ...m, name: names[m.user_id] || '—', me: m.user_id === S.session.user.id }));
}

/* ---------------- views ---------------- */
const langSelect = () => `<label class="f"><span class="sr">${esc(tx('language'))}</span><select id="lang" data-act="lang">
  ${CFG.languages.map(c => `<option value="${c}" ${c === lang ? 'selected' : ''}>${{ en: 'English only', 'en-pa': 'English + ਪੰਜਾਬੀ', 'en-hi': 'English + हिंदी', 'en-fr': 'English + Français' }[c] || c}</option>`).join('')}
  </select></label>`;
const inviteNote = () => pendingInvite() ? `<div class="alert ok" role="status">${esc(tx('invited_note'))}</div>` : '';
// Owner: trucks and trailers. Units are never deleted; "retire" hides them from new work but keeps history.
const unitRow = (v, solo) => {
  if (S.editVehicle === v.id) return `<form class="member" data-form="renameunit" novalidate>
      <input id="unitname" value="${esc(v.unit_number)}" maxlength="20" required aria-label="${esc(tx('unit_number'))}" style="flex:1">
      <div class="btns"><button class="btn go" style="width:auto" ${busyAttr()}>${L('save')}</button>
      <button type="button" class="btn" style="width:auto" data-act="canceledit">${L('cancel')}</button></div></form>`;
  if (S.confirmRetire === v.id) return `<div class="member"><div><b>${esc(v.unit_number)}</b>
      <div class="muted small">${esc(tx('confirm_retire'))}</div></div>
      <div class="btns"><button class="btn danger" style="width:auto" data-act="retire" data-id="${v.id}" ${busyAttr()}>${L('yes_retire')}</button>
      <button class="btn" style="width:auto" data-act="noretire">${L('cancel')}</button></div></div>`;
  return `<div class="member${solo ? ' solo' : ''}"><div>${solo ? '' : `<b>${esc(v.unit_number)}</b>`}${v.active ? '' : ` <span class="chip bad">${esc(tx('retired'))}</span>`}</div>
    <div class="btns">${v.active
      ? `<button class="btn" style="width:auto" data-act="editunit" data-id="${v.id}">${L('rename')}</button>
         <button class="btn danger" style="width:auto" data-act="askretire" data-id="${v.id}">${L('retire')}</button>`
      : `<button class="btn" style="width:auto" data-act="unretire" data-id="${v.id}" ${busyAttr()}>${L('bring_back')}</button>`}</div></div>`;
};
const vehiclesCard = () => {
  // Each type: a dropdown to pick one unit (then Rename / Retire for it), and an add box under it.
  const list = kind => S.vehicles.filter(v => v.kind === kind && v.active);
  // One line per type: "Truck [dropdown]". The dropdown lists the numbers plus Add new / Rename / Delete.
  const section = (kind, title, ph) => {
    const items = list(kind);
    const cur = items.find(v => v.id === S.pick[kind]) || items[0];
    const A = S.unitAction[kind];   // 'add' | 'rename' | 'delete' | undefined
    const word = tx(kind);          // Truck / Trailer
    const opts = (items.length
        ? items.map(v => `<option value="${v.id}" ${cur && v.id === cur.id ? 'selected' : ''}>${esc(v.unit_number)}</option>`).join('')
        : `<option value="" selected disabled>${esc(tx('none_pick'))}</option>`)
      + `<option value="__add">＋ ${esc(tx(kind === 'truck' ? 'add_truck' : 'add_trailer'))}</option>`
      + (cur ? `<option value="__rename">✎ ${esc(tx('rename'))} ${esc(cur.unit_number)}</option>
                <option value="__delete">✕ ${esc(tx('retire'))} ${esc(cur.unit_number)}</option>` : '');
    let panel = '';
    if (A === 'add') panel = `<form class="addrow" data-form="addunit" data-kind="${kind}" novalidate>
        <input id="unitnum-${kind}" maxlength="20" autocomplete="off" autocapitalize="characters" required placeholder="${ph}"
          aria-label="${esc(tx(kind === 'truck' ? 'truck_number' : 'trailer_number'))}">
        <button class="btn go" ${busyAttr()}>${L('add_unit')}</button>
        <button type="button" class="btn quiet" data-act="unitcancel" data-kind="${kind}">${esc(tx('cancel'))}</button></form>`;
    if (A === 'rename' && cur) panel = `<form class="addrow" data-form="renameunit" data-id="${cur.id}" data-kind="${kind}" novalidate>
        <input id="unitname" value="${esc(cur.unit_number)}" maxlength="20" required aria-label="${esc(tx('unit_number'))}">
        <button class="btn go" ${busyAttr()}>${L('save')}</button>
        <button type="button" class="btn quiet" data-act="unitcancel" data-kind="${kind}">${esc(tx('cancel'))}</button></form>`;
    if (A === 'delete' && cur) panel = `<div class="alert warn confirm"><b>${esc(word)} ${esc(cur.unit_number)}</b>
        <span class="small">${esc(tx('confirm_retire'))}</span>
        <div class="btns two"><button class="btn danger" data-act="retire" data-id="${cur.id}" data-kind="${kind}" ${busyAttr()}>${L('yes_retire')}</button>
        <button class="btn" data-act="unitcancel" data-kind="${kind}">${L('cancel')}</button></div></div>`;
    return `<div class="unitline"><span class="unitlbl"><span class="sub-ic">${ICON[kind]}</span>${L(kind)}</span>
      <select data-act="pick" data-kind="${kind}" aria-label="${esc(word)}">${opts}</select></div>${panel}`;
  };
  return `<div class="card">${sec('truck', 'trucks_trailers')}
    ${section('truck', 'trucks', '101')}${section('trailer', 'trailers', '205')}
    </div>`;
};
const msgBox = () => S.msg ?`<div class="alert ${S.msg.kind}" role="${S.msg.kind === 'bad' ? 'alert' : 'status'}">${esc(S.msg.text)}</div>` : '';
const busyAttr = () => S.busy ? 'disabled' : '';
const submitLabel = k => S.busy ? esc(tx('working')) : L(k);

/* ---------------- look ---------------- */
const ICON = {
  truck:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6h11v10H2zM13 9h4l4 4v3h-8"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
  trailer:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6h17v10H1zM18 13h4"/><circle cx="6" cy="18" r="2"/><circle cx="12" cy="18" r="2"/></svg>',
  users:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/></svg>',
  invite:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6"/></svg>',
  owner:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V8l6-4v17M9 21V10l12 4v7M3 21h18M13 17h4"/></svg>',
  driver:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 14.5V21M9.6 11.2 3.3 9.5M14.4 11.2l6.3-1.7"/></svg>',
  globe:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  doc:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
};
const sec = (icon, key, extra = '') => `<div class="sec"><span class="sec-ic">${ICON[icon]}</span><h2>${L(key)}</h2>${extra}</div>`;
const hero = (titleKey, subKey) => `<section class="band hero"><span class="hero-ic">${ICON.truck}</span>
  <h1>${L(titleKey)}</h1><p>${esc(tx(subKey))}</p></section>`;
const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

/* ---------------- paperwork (step 7) ---------------- */
const DOC_TYPES = ['fuel', 'load', 'expense', 'invoice'];
const DOC_IC = { fuel: '⛽', load: '📦', expense: '🧾', invoice: '💵' };
const unitName = id => { const v = S.vehicles.find(x => x.id === id); return v ? v.unit_number : ''; };
const whenText = t => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const sizeText = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const unitPicker = kind => {
  const items = S.vehicles.filter(v => v.kind === kind && v.active);
  const cur = items.find(v => v.id === S.dpick[kind]);
  return `<div class="unitline"><span class="unitlbl"><span class="sub-ic">${ICON[kind]}</span>${L(kind)}</span>
    <select data-act="dpick" data-kind="${kind}" aria-label="${esc(tx(kind))}">
      <option value="" ${cur ? '' : 'selected'}>${esc(items.length ? tx('none_chosen') : tx('none_yet'))}</option>
      ${items.map(v => `<option value="${v.id}" ${cur && cur.id === v.id ? 'selected' : ''}>${esc(v.unit_number)}</option>`).join('')}
      <option value="__add">＋ ${esc(tx(kind === 'truck' ? 'add_truck' : 'add_trailer'))}</option>
    </select></div>
    ${S.daddKind === kind ? `<form class="addrow" data-form="driveraddunit" data-kind="${kind}" novalidate>
      <input id="dunitnum-${kind}" maxlength="20" autocomplete="off" autocapitalize="characters" required placeholder="${kind === 'truck' ? '101' : '205'}"
        aria-label="${esc(tx(kind === 'truck' ? 'truck_number' : 'trailer_number'))}">
      <button class="btn go" ${busyAttr()}>${L('add_unit')}</button>
      <button type="button" class="btn quiet" data-act="daddcancel">${esc(tx('cancel'))}</button></form>` : ''}`;
};
const docRow = (d, showDriver) => {
  const driver = showDriver ? ((S.team.find(m => m.user_id === d.created_by) || {}).name || '—') : '';
  const units = [d.truck_id && tx('truck') + ' ' + unitName(d.truck_id), d.trailer_id && tx('trailer') + ' ' + unitName(d.trailer_id)].filter(Boolean).join(' · ');
  const det = d.details || {};
  const extra = [det.date, det.litres && det.litres + ' L', (det.from || det.to) && [det.from, det.to].filter(Boolean).join(' → '), det.note].filter(Boolean).join(' · ');
  const sent = d.current_version > 0 && d.file;
  const f = sent && S.files[d.file.storage_path];
  const open = S.openDoc === d.id;
  return `<div class="docrow"><span class="doc-ic" aria-hidden="true">${DOC_IC[d.type]}</span>
    <div class="doc-main"><b>${L('doc_' + d.type)}</b>
      <div class="muted small">${showDriver ? esc(driver) + ' · ' : ''}${esc(whenText(d.created_at))}${units ? ' · ' + esc(units) : ''}</div>
      ${extra ? `<div class="small">${esc(extra)}</div>` : ''}
      <div class="chips">${sent ? `<span class="chip ok">✓ ${L('sent_status')}</span>` : `<span class="chip warn">${L('not_finished')}</span>`}
        ${d.type === 'invoice' && sent ? (d.verification === 'verified' ? `<span class="chip ok">✓ ${L('verified')}</span>` : `<span class="chip warn">${L('pending_check')}</span>`) : ''}
        ${d.trashed_at ? `<span class="chip bad">${L('in_trash')}</span>` : ''}</div>
      ${ownerTools(d, sent)}
      ${open && f ? `<div class="preview">${/^image\//.test(f.blob.type) ? `<img src="${f.url}" alt="">` : ''}
        <div class="btns two"><a class="btn" href="${f.url}" target="_blank" rel="noopener">${L('view_full')}</a>
        <button class="btn go" data-act="sharedoc" data-id="${d.id}">${L('share')}</button></div>
        <button class="btn quiet" data-act="closedoc">${esc(tx('close'))}</button></div>` : ''}
    </div>
    <div class="doc-act">${sent
      ? (open && f ? '' : `<button class="btn" data-act="opendoc" data-id="${d.id}" ${busyAttr()}>${L('open')}</button>`)
      : (d.created_by === S.session.user.id ? `<button class="btn go" data-act="finishdoc" data-id="${d.id}">${L('finish')}</button>` : '')}</div>
  </div>`;
};
// Owner-only buttons. The server checks every one of these again (only an owner can verify, trash or restore).
const ownerTools = (d, sent) => {
  if (S.company.role !== 'owner') return '';
  if (d.trashed_at) return `<div class="btns"><button class="btn" data-act="restoredoc" data-id="${d.id}" ${busyAttr()}>${L('restore_paper')}</button></div>`;
  if (S.confirmTrash === d.id) return `<div class="alert warn confirm"><span class="small">${esc(tx('confirm_trash'))}</span>
      <div class="btns two"><button class="btn danger" data-act="trashdoc" data-id="${d.id}" ${busyAttr()}>${L('yes_trash')}</button>
      <button class="btn" data-act="notrash">${L('cancel')}</button></div></div>`;
  const canVerify = d.type === 'invoice' && sent && d.verification !== 'verified';
  return `<div class="btns${canVerify ? ' two' : ''}">${canVerify
      ? `<button class="btn go" data-act="verifydoc" data-id="${d.id}" ${busyAttr()}>${L('mark_verified')}</button>` : ''}
    <button class="btn quiet" data-act="asktrash" data-id="${d.id}">${L('move_trash')}</button></div>`;
};
const docList = (showDriver) => {
  const list = S.docs.filter(d => (S.docFilter === 'all' || d.type === S.docFilter)
    && (S.truckFilter === 'all' || d.truck_id === S.truckFilter || d.trailer_id === S.truckFilter));
  const units = kind => S.vehicles.filter(v => v.kind === kind && (v.active || S.docs.some(d => d.truck_id === v.id || d.trailer_id === v.id)));
  // Owner: pick a truck or trailer to see only its papers (its "folder").
  const unitFilter = showDriver ? `<label class="f"><span class="sr">${esc(tx('truck'))}</span><select data-act="truckfilter">
      <option value="all" ${S.truckFilter === 'all' ? 'selected' : ''}>${esc(tx('all_units'))}</option>
      ${['truck', 'trailer'].map(k => units(k).length ? `<optgroup label="${esc(tx(k === 'truck' ? 'trucks' : 'trailers'))}">${units(k).map(v =>
        `<option value="${v.id}" ${S.truckFilter === v.id ? 'selected' : ''}>${esc(tx(k))} ${esc(v.unit_number)}</option>`).join('')}</optgroup>` : '').join('')}
    </select></label>` : '';
  const trashToggle = showDriver ? `<button class="btn quiet" data-act="toggletrash" ${busyAttr()}>${esc(tx(S.showTrash ? 'back_to_papers' : 'show_trash'))}</button>` : '';
  return `${S.showTrash ? `<div class="alert warn small">${esc(tx('trash_help'))}</div>` : ''}${unitFilter}<label class="f"><span class="sr">${esc(tx('show'))}</span><select data-act="docfilter">
      <option value="all" ${S.docFilter === 'all' ? 'selected' : ''}>${esc(tx('all_types'))}</option>
      ${DOC_TYPES.map(t => `<option value="${t}" ${S.docFilter === t ? 'selected' : ''}>${esc(tx('doc_' + t))}</option>`).join('')}</select></label>
    ${list.length ? list.map(d => docRow(d, showDriver)).join('') : `<p class="muted" style="margin:0">${esc(tx('no_papers'))}</p>`}
    ${S.docs.length >= 100 ? `<p class="muted small" style="margin:0">${esc(tx('showing_latest'))}</p>` : ''}${trashToggle}`;
};
const driverHome = () => `
  <div class="card">${sec('truck', 'trucks_trailers')}${unitPicker('truck')}${unitPicker('trailer')}
    ${S.vehicles.some(v => v.active) ? '' : `<p class="muted small" style="margin:0">${esc(tx('no_trucks_driver'))}</p>`}</div>
  <div class="card">${sec('doc', 'send_paperwork')}
    <div class="typegrid">${DOC_TYPES.map(t => `<button class="typebtn" data-act="newdoc" data-t="${t}"><span class="type-ic" aria-hidden="true">${DOC_IC[t]}</span>${L('doc_' + t)}</button>`).join('')}</div></div>
  <div class="card">${sec('doc', 'my_papers')}${docList(false)}</div>`;
const sendView = () => {
  const s = S.send, d = s.details;
  const units = [S.dpick.truck && tx('truck') + ' ' + unitName(S.dpick.truck), S.dpick.trailer && tx('trailer') + ' ' + unitName(S.dpick.trailer)].filter(Boolean).join(' · ');
  const isPdf = s.pages.length === 1 && s.pages[0].pdf;
  const picker = (key, capture) => `<label class="btn ${s.pages.length ? '' : 'go'} big filebtn">${L(key)}
      <input type="file" data-act="addfile" ${capture ? 'accept="image/*" capture="environment"' : 'accept="image/*,application/pdf"'} hidden></label>`;
  return `<section class="band hero"><span class="hero-ic" aria-hidden="true" style="font-size:30px">${DOC_IC[s.type]}</span>
      <h1>${L('doc_' + s.type)}</h1><p>${esc(units || tx('no_unit_chosen'))}</p></section>${msgBox()}
    <div class="card">
      ${s.pages.length ? `<div class="pages">${s.pages.map((p, i) => `<figure>${p.pdf ? `<div class="pdfthumb">PDF</div>` : `<img src="${p.url}" alt="${esc(tx('page'))} ${i + 1}">`}
          <figcaption>${esc(tx('page'))} ${i + 1}</figcaption>
          <button class="btn quiet" data-act="rmpage" data-i="${i}" aria-label="${esc(tx('remove_page'))} ${i + 1}">✕ ${esc(tx('remove_page'))}</button></figure>`).join('')}</div>
        <p class="muted small" style="margin:0">${esc(tx('photo_check'))}</p>` : `<p class="muted" style="margin:0">${esc(tx(s.docId ? 'finish_help' : 'capture_help'))}</p>`}
      ${isPdf ? '' : picker(s.pages.length ? 'add_page' : 'take_photo', true)}
      ${s.pages.length ? '' : picker('choose_file', false)}
    </div>
    <details class="card" ${s.openDetails ? 'open' : ''}><summary>${L('details_optional')}</summary>
      <div class="fields">
        <label class="f">${L('doc_date')}<input type="date" data-det="date" value="${esc(d.date)}"></label>
        ${s.type === 'fuel' ? `<label class="f">${L('litres')}<input type="number" inputmode="decimal" min="0" step="0.01" data-det="litres" value="${esc(d.litres)}"></label>` : ''}
        ${s.type === 'load' ? `<label class="f">${L('from_place')}<input data-det="from" maxlength="80" value="${esc(d.from)}"></label>
          <label class="f">${L('to_place')}<input data-det="to" maxlength="80" value="${esc(d.to)}"></label>` : ''}
        <label class="f">${L('note')}<input data-det="note" maxlength="200" value="${esc(d.note)}"></label>
      </div></details>
    ${s.status ? `<div class="alert ok" role="status">${esc(s.status)}</div>` : ''}
    <button class="btn go big" data-act="senddoc" ${s.pages.length && !S.busy ? '' : 'disabled'}>${S.busy ? esc(tx('sending')) : L('send')}</button>
    <button class="btn quiet" data-act="cancelsend" ${busyAttr()}>${L('cancel')}</button>`;
};
const views = {
  loading: () => `<p class="muted">Loading…</p>`,
  signin: () => `${hero('sign_in', 'tagline')}${inviteNote()}${msgBox()}
    <form class="card fields" data-form="signin" novalidate>
      <label class="f">${L('email')}<input id="email" type="email" autocomplete="email" required></label>
      <label class="f">${L('password')}<input id="password" type="password" autocomplete="current-password" required></label>
      <button class="btn go big" ${busyAttr()}>${submitLabel('sign_in')}</button>
      <button type="button" class="btn quiet" data-act="go" data-v="forgot">${L('forgot_password')}</button>
    </form>
    <button class="btn" data-act="go" data-v="signup">${L('no_account')}</button>
    <div class="card">${sec('globe', 'language')}${langSelect()}</div>`,
  signup: () => `${hero('sign_up', 'tagline_signup')}${inviteNote()}${msgBox()}
    <form class="card fields" data-form="signup" novalidate>
      <label class="f">${L('email')}<input id="email" type="email" autocomplete="email" required></label>
      <label class="f">${L('password')}<input id="password" type="password" autocomplete="new-password" minlength="8" required>
        <span class="muted small">${esc(tx('password_rule'))}</span></label>
      <button class="btn go big" ${busyAttr()}>${submitLabel('sign_up')}</button>
    </form>
    <button class="btn" data-act="go" data-v="signin">${L('have_account')}</button>`,
  checkemail: () => `<h1>${L('welcome')}</h1><div class="alert ok">${esc(tx('check_email'))}</div>
    <button class="btn go" data-act="go" data-v="signin">${L('sign_in')}</button>`,
  forgot: () => `${hero('forgot_password', 'tagline_forgot')}${msgBox()}
    <form class="card fields" data-form="forgot" novalidate>
      <label class="f">${L('email')}<input id="email" type="email" autocomplete="email" required></label>
      <button class="btn go big" ${busyAttr()}>${submitLabel('send_reset')}</button>
    </form>
    <button class="btn quiet" data-act="go" data-v="signin">${L('sign_in')}</button>`,
  setpw: () => `<h1>${L('new_password')}</h1>${msgBox()}
    <form class="card fields" data-form="setpw" novalidate>
      <label class="f">${L('new_password')}<input id="password" type="password" autocomplete="new-password" minlength="8" required>
        <span class="muted small">${esc(tx('password_rule'))}</span></label>
      <button class="btn go big" ${busyAttr()}>${submitLabel('set_password')}</button>
    </form>`,
  onboard: () => `<section class="band hero"><span class="hero-ic">${ICON.truck}</span><h1>${L('welcome')}</h1>
    <p>${esc(S.session.user.email)}</p></section>${msgBox()}
    <h2>${L('choose_role')}</h2>
    <div class="choice">
      <button data-act="role" data-r="owner" aria-pressed="${S.roleChoice === 'owner'}"><span class="choice-ic">${ICON.owner}</span>${L('i_am_owner')}</button>
      <button data-act="role" data-r="driver" aria-pressed="${S.roleChoice === 'driver'}"><span class="choice-ic">${ICON.driver}</span>${L('i_am_driver')}</button>
    </div>
    ${S.roleChoice ? `<form class="card fields" data-form="${S.roleChoice === 'owner' ? 'createco' : 'join'}" novalidate>
      <label class="f">${L('full_name')}<input id="fullname" autocomplete="name" required value="${esc(S.profile && S.profile.full_name)}"></label>
      ${S.roleChoice === 'owner'
        ? `<label class="f">${L('company_name')}<input id="company" required></label>
           <button class="btn go big" ${busyAttr()}>${submitLabel('create_company')}</button>`
        : `<label class="f">${L('invite_code')}<input id="code" autocapitalize="characters" autocomplete="off" required value="${esc(pendingInvite())}"></label>
           <button class="btn go big" ${busyAttr()}>${submitLabel('join_company')}</button>`}
    </form>` : ''}
    <div class="card">${langSelect()}</div>
    <button class="btn quiet" data-act="signout">${L('sign_out')}</button>`,
  removed: () => `<h1>${L('welcome')}</h1>
    <div class="alert warn">Your access to this company was removed by the owner. Your past documents stay with the company. If this is a mistake, ask the owner to restore your access.</div>
    <button class="btn quiet" data-act="signout">${L('sign_out')}</button>`,
  home: () => {
    const c = S.company;
    const header = `<section class="band company"><div><div class="eyebrow">${esc(tx('hello'))}, ${esc(S.profile && S.profile.full_name)}</div>
      <h1>${esc(c.name)}</h1></div><span class="chip role">${esc(tx(c.role))}</span></section>${msgBox()}`;
    const count = k => S.vehicles.filter(v => v.kind === k && v.active).length;
    const stats = `<div class="stats">
      <div><span class="stat-ic">${ICON.users}</span><b>${S.team.filter(m => m.active && m.role === 'driver').length}</b><span>${esc(tx('drivers'))}</span></div>
      <div><span class="stat-ic">${ICON.truck}</span><b>${count('truck')}</b><span>${esc(tx('trucks'))}</span></div>
      <div><span class="stat-ic">${ICON.trailer}</span><b>${count('trailer')}</b><span>${esc(tx('trailers'))}</span></div></div>`;
    if (c.role === 'driver') return header + driverHome() + `
      <div class="card">${sec('globe', 'language')}${langSelect()}</div><button class="btn quiet" data-act="signout">${L('sign_out')}</button>`;
    return header + stats + `
      <div class="card">${sec('users', 'team')}
        ${S.team.filter(m => m.active || S.showRemoved).map(m => `<div class="member"><div class="who"><span class="avatar">${esc(initials(m.name))}</span><div><b>${esc(m.name)}</b>${m.me ? ' <span class="muted small">(you)</span>' : ''}<div class="muted small">${esc(tx(m.role))} · ${m.active ? '<span class="chip ok">' + esc(tx('active')) + '</span>' : '<span class="chip bad">' + esc(tx('removed')) + '</span>'}</div></div></div>
          ${m.me ? '' : (m.active
            ? (S.confirmUser === m.user_id
                ? `<div class="btns"><button class="btn danger" data-act="remove" data-u="${m.user_id}" ${busyAttr()}>${L('yes_remove')}</button><button class="btn" data-act="noconfirm">${L('cancel')}</button></div>`
                : `<button class="btn danger" style="width:auto" data-act="askremove" data-u="${m.user_id}">${L('remove_access')}</button>`)
            : `<button class="btn" style="width:auto" data-act="restore" data-u="${m.user_id}" ${busyAttr()}>${L('restore_access')}</button>`)}
        </div>${S.confirmUser === m.user_id ? `<p class="muted small" style="margin:0">${esc(tx('confirm_remove'))}</p>` : ''}`).join('')}
        ${S.team.some(m => !m.active) ? `<button class="btn quiet" data-act="toggleremoved">${esc(S.showRemoved ? tx('hide_removed') : tx('show_removed') + ' (' + S.team.filter(m => !m.active).length + ')')}</button>` : ''}
      </div>
      ${vehiclesCard()}
      <div class="card">${sec('invite', 'invite_driver')}<p class="muted small" style="margin:0">${esc(tx('invite_help'))}</p>
        ${S.inviteCode ? `<div class="code" id="invcode">${esc(S.inviteCode)}</div><p class="muted small" style="margin:0">${esc(tx('invite_link_ready'))}</p>
          <button class="btn go" data-act="share">${L('share_link')}</button>
          <button class="btn" data-act="copy">${L('copy_link')}</button>`
          : `<button class="btn go" data-act="invite" ${busyAttr()}>${L('invite_driver')}</button>`}
      </div>
      <div class="card">${sec('doc', 'papers_inbox', `<button class="btn quiet" style="width:auto;margin-left:auto" data-act="refreshdocs" ${busyAttr()}>↻ ${esc(tx('refresh'))}</button>`)}${docList(true)}</div>
      <div class="card">${sec('globe', 'language')}${langSelect()}</div>
      <button class="btn quiet" data-act="signout">${L('sign_out')}</button>`;
  },
  send: sendView,
};

function render() {
  const el = document.getElementById('app');
  el.innerHTML = `<header><span class="brandwrap"><span class="logo">${ICON.truck}</span><span class="brand">Truck<b>Docs</b></span></span>${CFG.environment !== 'production' ? '<span class="env">Test version</span>' : ''}</header>
    <main>${views[S.view]()}</main>`;
}
// Values typed into the form are copied BEFORE the screen redraws (a redraw empties the boxes).
let typed = {};
const snapshot = () => { typed = {}; app.querySelectorAll('input, select, textarea').forEach(el => { if (el.id) typed[el.id] = el.value; }); };
const val = id => (id in typed ? typed[id] : (document.getElementById(id) || {}).value) || '';
// After a redraw, put back what the person typed (never the password, for safety).
const refill = () => Object.entries(typed).forEach(([id, v]) => { const el = document.getElementById(id); if (el && el.type !== 'password' && !el.value) el.value = v; });

/* ---------------- paperwork logic (step 7) ---------------- */
const MAX_BYTES = 15 * 1024 * 1024;          // safety limit per paper (phone photos are shrunk well below this)
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
// Shrink a phone photo to a clear but small JPEG (long side 2200 px). If the phone can't decode it, keep the original.
async function shrinkPhoto(file) {
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const k = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.82));
    if (blob && blob.size) return { blob, w: c.width, h: c.height };
  } catch { /* fall through */ }
  return { blob: file, w: 0, h: 0 };
}
let jsPdfReady = null;
const loadJsPdf = () => jsPdfReady || (jsPdfReady = new Promise((ok, bad) => {
  const el = document.createElement('script');
  el.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  el.onload = () => (window.jspdf ? ok(window.jspdf.jsPDF) : bad(new Error(tx('pdf_failed'))));
  el.onerror = () => { jsPdfReady = null; bad(new Error(tx('pdf_failed'))); };
  document.head.appendChild(el);
}));
// One page → the photo itself. Several pages → one PDF, one page per photo. A chosen PDF goes as it is.
async function buildFile(pages) {
  if (pages.length === 1) {
    const p = pages[0];
    return { blob: p.blob, mime: p.blob.type || (p.pdf ? 'application/pdf' : 'image/jpeg'), ext: p.pdf ? 'pdf' : 'jpg' };
  }
  const JsPDF = await loadJsPdf();
  let doc = null;
  for (const p of pages) {
    const w = 612, h = p.w && p.h ? Math.round(612 * p.h / p.w) : 792;   // letter width, keep the photo's shape
    const data = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(p.blob); });
    if (!doc) doc = new JsPDF({ unit: 'pt', format: [w, h], orientation: w > h ? 'l' : 'p' });
    else doc.addPage([w, h], w > h ? 'l' : 'p');
    doc.addImage(data, 'JPEG', 0, 0, w, h);
  }
  return { blob: doc.output('blob'), mime: 'application/pdf', ext: 'pdf' };
}
async function sha256(blob) {
  const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}
// Sending happens in 3 server steps. "Sent" is shown only after the server has confirmed all three.
// If something fails halfway, the paper shows "Not sent yet" in the list and can be finished later — never lost, never faked.
async function sendDoc() {
  const s = S.send;
  s.status = tx('preparing'); render();
  const f = await buildFile(s.pages);
  if (f.blob.size > MAX_BYTES) throw new Error(tx('file_too_big'));
  if (!s.docId) {
    const id = crypto.randomUUID();
    const det = Object.fromEntries(Object.entries(s.details).map(([k, v]) => [k, String(v || '').trim()]).filter(([, v]) => v));
    if (det.litres) { const n = Number(det.litres); if (!(n > 0 && n < 5000)) throw new Error(tx('litres_bad')); det.litres = n; }
    const { error } = await sb.from('documents').insert({ id, company_id: S.company.id, type: s.type,
      truck_id: S.dpick.truck || null, trailer_id: S.dpick.trailer || null, details: det });
    if (error) throw error;
    s.docId = id;                            // from here a retry continues this same paper instead of making a copy
  }
  s.status = tx('uploading'); render();
  const hash = await sha256(f.blob);
  const path = `${S.company.id}/docs/${s.docId}/${hash.slice(0, 20)}.${f.ext}`;
  const up = await sb.storage.from('documents').upload(path, f.blob, { contentType: f.mime, upsert: false, cacheControl: '0' });
  if (up.error && !/exist|duplicate/i.test(up.error.message || '')) throw up.error;   // "already there" = an earlier try got through
  s.status = tx('confirming'); render();
  const v = await sb.from('document_versions').insert({ document_id: s.docId, storage_path: path, sha256: hash,
    size_bytes: f.blob.size, mime_type: f.mime });
  if (v.error && !/document_versions_storage_path_key|duplicate key/i.test(v.error.message || '')) throw v.error;
  // Double-check with the server before saying "Sent".
  const { data: chk, error: ce } = await sb.from('documents').select('current_version').eq('id', s.docId).maybeSingle();
  if (ce) throw ce;
  if (!chk || !(chk.current_version > 0)) throw new Error(tx('not_confirmed'));
  s.pages.forEach(p => p.url && URL.revokeObjectURL(p.url));
  S.send = null; S.view = 'home'; S.docFilter = 'all';
  await loadDocs();
  setMsg('ok', tx(S.company.role === 'owner' ? 'sent_ok_owner' : 'sent_ok'));
}
// Opening a file always goes through the td-file server check (access is re-checked every time).
async function fetchFile(path) {
  if (S.files[path]) return S.files[path];
  const { data } = await sb.auth.getSession();
  if (!data.session) throw new Error(tx('error_generic'));
  const r = await fetch(`${CFG.supabaseUrl}/functions/v1/td-file?path=${encodeURIComponent(path)}`,
    { headers: { Authorization: 'Bearer ' + data.session.access_token, apikey: CFG.supabaseKey }, cache: 'no-store' });
  if (!r.ok) throw new Error(tx('open_failed'));
  const blob = await r.blob();
  return (S.files[path] = { blob, url: URL.createObjectURL(blob) });
}
const fileNameFor = d => `${tx('doc_' + d.type).replace(/\s+/g, '-')}_${(d.details && d.details.date) || d.created_at.slice(0, 10)}${d.truck_id ? '_T' + unitName(d.truck_id) : ''}.${/pdf/.test(d.file.mime_type || '') ? 'pdf' : 'jpg'}`;
async function addFiles(input) {
  const files = Array.from(input.files || []); input.value = '';
  if (!files.length || !S.send) return;
  const s = S.send;
  for (const file of files) {
    const pdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (pdf) {
      if (s.pages.length) { setMsg('bad', tx('pdf_alone')); continue; }
      if (file.size > MAX_BYTES) { setMsg('bad', tx('file_too_big')); continue; }
      s.pages.push({ blob: file, pdf: true }); setMsg(null); continue;
    }
    if (s.pages.length >= 15) { setMsg('bad', tx('too_many_pages')); break; }
    const p = await shrinkPhoto(file);
    s.pages.push({ ...p, url: URL.createObjectURL(p.blob) }); setMsg(null);
  }
  render();
}

/* ---------------- actions ---------------- */
async function run(fn) {
  if (S.busy) return;
  snapshot();
  S.busy = true; setMsg(null); render();
  let failed = false;
  try { await fn(); } catch (err) { failed = true; setMsg('bad', friendly(err)); }
  finally { S.busy = false; render(); if (failed) refill(); typed = {}; }   // keep what was typed only if it didn't go through
}

const forms = {
  async signin() {
    const { data, error } = await sb.auth.signInWithPassword({ email: val('email').trim(), password: val('password') });
    if (error) throw error;
    S.session = data.session; await loadContext();
  },
  async signup() {
    if (val('password').length < 8) throw new Error(tx('password_rule'));
    const inv = pendingInvite();   // travels with the account, so it still works if the email link opens in another browser
    const { data, error } = await sb.auth.signUp({ email: val('email').trim(), password: val('password'),
      options: { emailRedirectTo: RETURN_URL, data: inv ? { invite: inv } : undefined } });
    if (error) throw error;
    if (data.session) { S.session = data.session; await loadContext(); } else S.view = 'checkemail';
  },
  async forgot() {
    const { error } = await sb.auth.resetPasswordForEmail(val('email').trim(), { redirectTo: RETURN_URL });
    if (error) throw error;
    setMsg('ok', tx('reset_sent'));
  },
  async setpw() {
    if (val('password').length < 8) throw new Error(tx('password_rule'));
    const { error } = await sb.auth.updateUser({ password: val('password') });
    if (error) throw error;
    const { data } = await sb.auth.getSession(); S.session = data.session;
    await loadContext(); setMsg('ok', tx('password_saved'));
  },
  async createco() {
    const { error } = await sb.rpc('create_company', { p_name: val('company').trim(), p_full_name: val('fullname').trim(), p_language: lang });
    if (error) throw error;
    await loadContext();
  },
  async addunit(form) {
    const kind = form.dataset.kind === 'trailer' ? 'trailer' : 'truck';
    const num = val('unitnum-' + kind).trim();
    if (!num) throw new Error(tx('unit_number_needed'));
    const norm = num.toUpperCase().replace(/\s+/g, ' ');
    const same = S.vehicles.find(v => v.kind === kind && v.unit_number === norm);
    if (same && same.active) { S.pick[kind] = same.id; throw new Error(tx('unit_exists')); }
    if (same) {   // it was retired: bring it back instead of refusing
      const { data, error } = await sb.from('vehicles').update({ active: true }).eq('id', same.id).select('id');
      if (error) throw error;
      if (!data || !data.length) throw new Error(tx('not_saved'));
      await loadVehicles(); S.pick[kind] = same.id; S.unitAction[kind] = null;
      return setMsg('ok', tx('unit_back_number').replace('{n}', norm));
    }
    const { error } = await sb.from('vehicles').insert({ company_id: S.company.id, kind, unit_number: num });
    if (error) throw error;
    await loadVehicles();
    const added = S.vehicles.find(v => v.kind === kind && v.unit_number === num.toUpperCase().replace(/\s+/g, ' '));
    if (added) S.pick[kind] = added.id;   // show the new one in the dropdown
    S.unitAction[kind] = null;
    setMsg('ok', tx(kind === 'truck' ? 'truck_added' : 'trailer_added').replace('{n}', num.toUpperCase()));
  },
  async renameunit(form) {
    const num = val('unitname').trim();
    if (!num) throw new Error(tx('unit_number_needed'));
    const { data, error } = await sb.from('vehicles').update({ unit_number: num }).eq('id', form.dataset.id).select('id');
    if (error) throw error;
    if (!data || !data.length) throw new Error(tx('not_saved'));   // never claim success the server didn't confirm
    S.unitAction[form.dataset.kind] = null; await loadVehicles(); setMsg('ok', tx('saved'));
  },
  async driveraddunit(form) {
    const kind = form.dataset.kind === 'trailer' ? 'trailer' : 'truck';
    const num = val('dunitnum-' + kind).trim();
    if (!num) throw new Error(tx('unit_number_needed'));
    const { data, error } = await sb.rpc('add_unit', { p_company: S.company.id, p_kind: kind, p_number: num });
    if (error) throw error;
    if (!data) throw new Error(tx('not_saved'));   // never claim success the server didn't confirm
    await loadVehicles();
    const v = S.vehicles.find(x => x.id === data);
    if (!v) throw new Error(tx('not_saved'));
    S.dpick[kind] = v.id; S.daddKind = null;
    try { localStorage.setItem('td_dpick', JSON.stringify(S.dpick)); } catch { /* private mode */ }
    setMsg('ok', tx(kind === 'truck' ? 'truck_ready' : 'trailer_ready').replace('{n}', v.unit_number));
  },
  async join() {
    const { error } = await sb.rpc('accept_invite', { p_code: val('code').trim(), p_full_name: val('fullname').trim(), p_language: lang });
    if (error) throw error;
    keep.set(INVITE_KEY, null);
    if (S.session.user.user_metadata && S.session.user.user_metadata.invite) await sb.auth.updateUser({ data: { invite: null } });
    await loadContext();
  },
};

const app = document.getElementById('app');
app.addEventListener('submit', e => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault(); run(() => forms[f.dataset.form](f));
});
app.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
  const a = b.dataset.act;
  if (a === 'go') { S.view = b.dataset.v; setMsg(null); render(); }
  if (a === 'role') { S.roleChoice = b.dataset.r; setMsg(null); render(); }
  if (a === 'signout') run(async () => { await sb.auth.signOut(); Object.assign(S, { session: null, company: null, team: [], inviteCode: null, view: 'signin' }); });
  if (a === 'invite') run(async () => {
    const { data, error } = await sb.rpc('create_invite', { p_company: S.company.id }); if (error) throw error; S.inviteCode = data;
  });
  if (a === 'copy') {
    const done = () => { b.textContent = tx('copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(inviteLink(S.inviteCode)).then(done, () => {});
  }
  if (a === 'share') {
    const url = inviteLink(S.inviteCode);
    const text = tx('share_text').replace('{company}', S.company.name);
    // The phone's own share sheet (WhatsApp, Messages, email…). Falls back to copying the link.
    if (navigator.share) navigator.share({ title: 'TruckDocs', text, url }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(text + ' ' + url).then(() => { b.textContent = tx('copied'); }, () => {});
  }
  if (a === 'editunit') { S.editVehicle = b.dataset.id; S.confirmRetire = null; setMsg(null); render(); }
  if (a === 'canceledit') { S.editVehicle = null; render(); }
  if (a === 'unitcancel') { S.unitAction[b.dataset.kind] = null; render(); }
  if (a === 'askretire') { S.confirmRetire = b.dataset.id; S.editVehicle = null; render(); }
  if (a === 'noretire') { S.confirmRetire = null; render(); }
  if (a === 'toggleremoved') { S.showRemoved = !S.showRemoved; render(); }
  if (a === 'toggleretired') { S.showRetired = !S.showRetired; render(); }
  if (a === 'retire' || a === 'unretire') run(async () => {
    const { data, error } = await sb.from('vehicles').update({ active: a === 'unretire' }).eq('id', b.dataset.id).select('id');
    if (error) throw error;
    if (!data || !data.length) throw new Error(tx('not_saved'));
    S.confirmRetire = null; if (b.dataset.kind) { S.unitAction[b.dataset.kind] = null; S.pick[b.dataset.kind] = null; }
    await loadVehicles(); setMsg('ok', tx(a === 'retire' ? 'unit_retired' : 'unit_back'));
  });
  if (a === 'newdoc' || a === 'finishdoc') {
    const d = a === 'finishdoc' ? S.docs.find(x => x.id === b.dataset.id) : null;
    if (d) { S.dpick.truck = d.truck_id || ''; S.dpick.trailer = d.trailer_id || ''; }
    S.send = { type: d ? d.type : b.dataset.t, pages: [], docId: d ? d.id : null, status: '',
               details: d ? { ...d.details } : { date: today() } };
    S.view = 'send'; setMsg(null); render(); window.scrollTo(0, 0);
  }
  if (a === 'rmpage' && S.send) { const [p] = S.send.pages.splice(+b.dataset.i, 1); if (p && p.url) URL.revokeObjectURL(p.url); render(); }
  if (a === 'cancelsend') { if (S.send) S.send.pages.forEach(p => p.url && URL.revokeObjectURL(p.url)); S.send = null; S.view = 'home'; setMsg(null); render(); }
  if (a === 'senddoc' && S.send) run(async () => {
    try { await sendDoc(); }
    catch (err) {
      if (S.send) S.send.status = S.send.docId ? tx('send_failed_kept') : '';
      throw err;
    }
  });
  if (a === 'opendoc') run(async () => {
    const d = S.docs.find(x => x.id === b.dataset.id); if (!d || !d.file) return;
    await fetchFile(d.file.storage_path); S.openDoc = d.id;
  });
  if (a === 'closedoc') { S.openDoc = null; render(); }
  if (a === 'daddcancel') { S.daddKind = null; render(); }
  if (a === 'asktrash') { S.confirmTrash = b.dataset.id; render(); }
  if (a === 'notrash') { S.confirmTrash = null; render(); }
  if (a === 'toggletrash') run(async () => { S.showTrash = !S.showTrash; S.openDoc = null; S.confirmTrash = null; await loadDocs(); });
  if (a === 'verifydoc' || a === 'trashdoc' || a === 'restoredoc') run(async () => {
    const fn = { verifydoc: 'verify_invoice', trashdoc: 'trash_document', restoredoc: 'restore_document' }[a];
    const { error } = await sb.rpc(fn, { p_document: b.dataset.id });
    if (error) throw error;
    S.confirmTrash = null; S.openDoc = null; await loadDocs();
    // Report only what the server now shows.
    const d = S.docs.find(x => x.id === b.dataset.id);
    if (a === 'verifydoc' && !(d && d.verification === 'verified')) throw new Error(tx('not_saved'));
    if (a !== 'verifydoc' && d) throw new Error(tx('not_saved'));   // it should have left this list
    setMsg('ok', tx({ verifydoc: 'invoice_verified', trashdoc: 'paper_trashed', restoredoc: 'paper_restored' }[a]));
  });
  if (a === 'refreshdocs') run(loadDocs);
  if (a === 'sharedoc') {
    // The phone's own share sheet: WhatsApp, email, Messages, Print, Save to Files. Needs the file already opened.
    const d = S.docs.find(x => x.id === b.dataset.id); const f = d && d.file && S.files[d.file.storage_path];
    if (!f) return;
    const file = new File([f.blob], fileNameFor(d), { type: f.blob.type || d.file.mime_type || 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: tx('doc_' + d.type) }).catch(() => {});
    } else {   // computer or older phone: download the file instead
      const l = document.createElement('a'); l.href = f.url; l.download = file.name; document.body.appendChild(l); l.click(); l.remove();
    }
  }
  if (a === 'askremove') { S.confirmUser = b.dataset.u; render(); }
  if (a === 'noconfirm') { S.confirmUser = null; render(); }
  if (a === 'remove' || a === 'restore') run(async () => {
    const { error } = await sb.rpc('set_member_active', { p_company: S.company.id, p_user: b.dataset.u, p_active: a === 'restore' });
    if (error) throw error; S.confirmUser = null; await loadTeam();
    setMsg('ok', a === 'remove' ? 'Access removed. Their documents stay with the company.' : 'Access restored.');
  });
});
app.addEventListener('change', async e => {
  const act = e.target.dataset.act;
  if (act === 'addfile') { snapDetails(); return addFiles(e.target); }
  if (act === 'truckfilter') { S.truckFilter = e.target.value; S.openDoc = null; return render(); }
  if (act === 'dpick' && e.target.value === '__add') {
    S.daddKind = e.target.dataset.kind; setMsg(null); render();
    const box = document.getElementById('dunitnum-' + S.daddKind); if (box) box.focus();
    return;
  }
  if (act === 'dpick') {
    S.dpick[e.target.dataset.kind] = e.target.value;
    try { localStorage.setItem('td_dpick', JSON.stringify(S.dpick)); } catch { /* private mode */ }
    return;
  }
  if (act === 'docfilter') { S.docFilter = e.target.value; S.openDoc = null; return render(); }
  if (e.target.dataset.act === 'pick') {
    const k = e.target.dataset.kind, v = e.target.value; setMsg(null);
    if (v === '__add') S.unitAction[k] = 'add';
    else if (v === '__rename') S.unitAction[k] = 'rename';
    else if (v === '__delete') S.unitAction[k] = 'delete';
    else { S.pick[k] = v; S.unitAction[k] = null; }
    render();
    const box = document.getElementById(S.unitAction[k] === 'rename' ? 'unitname' : 'unitnum-' + k); if (box) box.focus();
    return;
  }
  if (e.target.dataset.act !== 'lang') return;
  lang = e.target.value; localStorage.setItem('td_lang', lang); await loadLang(SECOND[lang]);
  if (S.session && S.profile) {
    const { error } = await sb.from('profiles').update({ language: lang }).eq('user_id', S.session.user.id);
    if (error) setMsg('bad', friendly(error));
  }
  render();
});

// Optional details are kept as they are typed, so adding a page (which redraws the screen) never loses them.
const snapDetails = () => { if (!S.send) return; app.querySelectorAll('[data-det]').forEach(el => { S.send.details[el.dataset.det] = el.value; });
  const det = app.querySelector('details'); if (det) S.send.openDetails = det.open; };
app.addEventListener('input', e => { if (S.send && e.target.dataset.det) S.send.details[e.target.dataset.det] = e.target.value; });
app.addEventListener('toggle', e => { if (S.send && e.target.tagName === 'DETAILS') S.send.openDetails = e.target.open; }, true);

sb.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') { S.session = session; S.view = 'setpw'; setMsg(null); render(); }
});

(async function boot() {
  try { const r = await fetch('i18n/en.json', { cache: 'no-cache' }); if (r.ok) I18N.en = await r.json(); } catch { /* fall back to keys */ }
  await loadLang(SECOND[lang]);
  const q = new URLSearchParams(location.search).get('invite');
  if (q && /^[A-Za-z0-9]{6,20}$/.test(q)) { keep.set(INVITE_KEY, q.toUpperCase()); history.replaceState(null, '', RETURN_URL + location.hash); }
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  if (S.view === 'setpw') return render();
  if (!S.session) { S.view = pendingInvite() ? 'signup' : 'signin'; return render(); }
  try { await loadContext(); } catch (err) { S.view = 'signin'; setMsg('bad', friendly(err)); }
  render();
})();
})();
