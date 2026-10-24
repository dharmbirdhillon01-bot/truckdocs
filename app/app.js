/* TruckDocs — Phase 1 step 5: accounts and access.
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
            msg: null, busy: false, inviteCode: null, confirmUser: null, roleChoice: null };
const setMsg = (kind, text) => { S.msg = text ? { kind, text } : null; };
function friendly(err) {
  const m = (err && (err.message || err.error_description)) || tx('error_generic');
  if (/Invalid login credentials/i.test(m)) return 'Email or password is not correct.';
  if (/Email not confirmed/i.test(m)) return 'Please confirm your email first. Check your inbox for the link.';
  if (/rate limit/i.test(m)) return 'Too many emails sent in a short time. Please wait a few minutes and try again.';
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
  if (S.company && S.company.role === 'owner') await loadTeam();
  S.view = S.company ? 'home' : (S.memberships.some(m => !m.active) ? 'removed' : 'onboard');
  if (S.view === 'onboard' && pendingInvite()) S.roleChoice = 'driver';
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
const langSelect = () => `<label class="f">${L('language')}<select id="lang" data-act="lang">
  ${CFG.languages.map(c => `<option value="${c}" ${c === lang ? 'selected' : ''}>${{ en: 'English only', 'en-pa': 'English + ਪੰਜਾਬੀ', 'en-hi': 'English + हिंदी', 'en-fr': 'English + Français' }[c] || c}</option>`).join('')}
  </select></label>`;
const inviteNote = () => pendingInvite() ? `<div class="alert ok" role="status">${esc(tx('invited_note'))}</div>` : '';
const msgBox = () => S.msg ?`<div class="alert ${S.msg.kind}" role="${S.msg.kind === 'bad' ? 'alert' : 'status'}">${esc(S.msg.text)}</div>` : '';
const busyAttr = () => S.busy ? 'disabled' : '';
const submitLabel = k => S.busy ? esc(tx('working')) : L(k);

const views = {
  loading: () => `<p class="muted">Loading…</p>`,
  signin: () => `<h1>${L('sign_in')}</h1>${inviteNote()}${msgBox()}
    <form class="card fields" data-form="signin" novalidate>
      <label class="f">${L('email')}<input id="email" type="email" autocomplete="email" required></label>
      <label class="f">${L('password')}<input id="password" type="password" autocomplete="current-password" required></label>
      <button class="btn go big" ${busyAttr()}>${submitLabel('sign_in')}</button>
      <button type="button" class="btn quiet" data-act="go" data-v="forgot">${L('forgot_password')}</button>
    </form>
    <button class="btn" data-act="go" data-v="signup">${L('no_account')}</button>
    <div class="card">${langSelect()}</div>`,
  signup: () => `<h1>${L('sign_up')}</h1>${inviteNote()}${msgBox()}
    <form class="card fields" data-form="signup" novalidate>
      <label class="f">${L('email')}<input id="email" type="email" autocomplete="email" required></label>
      <label class="f">${L('password')}<input id="password" type="password" autocomplete="new-password" minlength="8" required>
        <span class="muted small">${esc(tx('password_rule'))}</span></label>
      <button class="btn go big" ${busyAttr()}>${submitLabel('sign_up')}</button>
    </form>
    <button class="btn" data-act="go" data-v="signin">${L('have_account')}</button>`,
  checkemail: () => `<h1>${L('welcome')}</h1><div class="alert ok">${esc(tx('check_email'))}</div>
    <button class="btn go" data-act="go" data-v="signin">${L('sign_in')}</button>`,
  forgot: () => `<h1>${L('forgot_password')}</h1>${msgBox()}
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
  onboard: () => `<h1>${L('welcome')}</h1>${msgBox()}
    <p class="muted" style="margin:0">${esc(S.session.user.email)}</p>
    <h2>${L('choose_role')}</h2>
    <div class="choice">
      <button data-act="role" data-r="owner" aria-pressed="${S.roleChoice === 'owner'}">${L('i_am_owner')}</button>
      <button data-act="role" data-r="driver" aria-pressed="${S.roleChoice === 'driver'}">${L('i_am_driver')}</button>
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
    const header = `<div class="row"><div><div class="muted small">${esc(S.profile && S.profile.full_name)}</div><h1>${esc(c.name)}</h1></div>
      <span class="chip ${c.role === 'owner' ? 'ok' : ''}">${esc(tx(c.role))}</span></div>${msgBox()}`;
    if (c.role === 'driver') return header + `<div class="card"><p style="margin:0">${esc(tx('driver_home_note'))}</p></div>
      <div class="card">${langSelect()}</div><button class="btn quiet" data-act="signout">${L('sign_out')}</button>`;
    return header + `
      <div class="card"><div class="row"><h2>${L('team')}</h2></div>
        ${S.team.map(m => `<div class="member"><div><b>${esc(m.name)}</b>${m.me ? ' <span class="muted small">(you)</span>' : ''}<div class="muted small">${esc(tx(m.role))} · ${m.active ? '<span class="chip ok">' + esc(tx('active')) + '</span>' : '<span class="chip bad">' + esc(tx('removed')) + '</span>'}</div></div>
          ${m.me ? '' : (m.active
            ? (S.confirmUser === m.user_id
                ? `<div class="btns"><button class="btn danger" data-act="remove" data-u="${m.user_id}" ${busyAttr()}>${L('yes_remove')}</button><button class="btn" data-act="noconfirm">${L('cancel')}</button></div>`
                : `<button class="btn danger" style="width:auto" data-act="askremove" data-u="${m.user_id}">${L('remove_access')}</button>`)
            : `<button class="btn" style="width:auto" data-act="restore" data-u="${m.user_id}" ${busyAttr()}>${L('restore_access')}</button>`)}
        </div>${S.confirmUser === m.user_id ? `<p class="muted small" style="margin:0">${esc(tx('confirm_remove'))}</p>` : ''}`).join('')}
      </div>
      <div class="card"><h2>${L('invite_driver')}</h2>
        ${S.inviteCode ? `<div class="code" id="invcode">${esc(S.inviteCode)}</div><p class="muted small" style="margin:0">${esc(tx('invite_link_ready'))}</p>
          <button class="btn go" data-act="share">${L('share_link')}</button>
          <button class="btn" data-act="copy">${L('copy_link')}</button>`
          : `<button class="btn go" data-act="invite" ${busyAttr()}>${L('invite_driver')}</button>`}
      </div>
      <div class="card"><p class="muted" style="margin:0">${esc(tx('owner_home_note'))}</p></div>
      <div class="card">${langSelect()}</div>
      <button class="btn quiet" data-act="signout">${L('sign_out')}</button>`;
  },
};

function render() {
  const el = document.getElementById('app');
  el.innerHTML = `<header><span class="brand">Truck<b>Docs</b></span>${CFG.environment !== 'production' ? '<span class="env">Test version</span>' : ''}</header>
    <main>${views[S.view]()}</main>`;
}
// Values typed into the form are copied BEFORE the screen redraws (a redraw empties the boxes).
let typed = {};
const snapshot = () => { typed = {}; app.querySelectorAll('input, select, textarea').forEach(el => { if (el.id) typed[el.id] = el.value; }); };
const val = id => (id in typed ? typed[id] : (document.getElementById(id) || {}).value) || '';
// After a redraw, put back what the person typed (never the password, for safety).
const refill = () => Object.entries(typed).forEach(([id, v]) => { const el = document.getElementById(id); if (el && el.type !== 'password' && !el.value) el.value = v; });

/* ---------------- actions ---------------- */
async function run(fn) {
  if (S.busy) return;
  snapshot();
  S.busy = true; setMsg(null); render();
  try { await fn(); } catch (err) { setMsg('bad', friendly(err)); }
  finally { S.busy = false; render(); refill(); typed = {}; }
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
  e.preventDefault(); run(forms[f.dataset.form]);
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
  if (a === 'askremove') { S.confirmUser = b.dataset.u; render(); }
  if (a === 'noconfirm') { S.confirmUser = null; render(); }
  if (a === 'remove' || a === 'restore') run(async () => {
    const { error } = await sb.rpc('set_member_active', { p_company: S.company.id, p_user: b.dataset.u, p_active: a === 'restore' });
    if (error) throw error; S.confirmUser = null; await loadTeam();
    setMsg('ok', a === 'remove' ? 'Access removed. Their documents stay with the company.' : 'Access restored.');
  });
});
app.addEventListener('change', async e => {
  if (e.target.dataset.act !== 'lang') return;
  lang = e.target.value; localStorage.setItem('td_lang', lang); await loadLang(SECOND[lang]);
  if (S.session && S.profile) {
    const { error } = await sb.from('profiles').update({ language: lang }).eq('user_id', S.session.user.id);
    if (error) setMsg('bad', friendly(error));
  }
  render();
});

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
