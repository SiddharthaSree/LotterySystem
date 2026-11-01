const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(value)) + ' IST';
const ticketCode = id => `CSI-${String(id).padStart(6, '0')}`;
const state = { session: {}, events: [], eventId: null, data: null, me: null, admin: null, tab: 'people', personId: null, authTab: 'signup', busy: false };
let toastTimer;

async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-csrf-token': state.session.csrf || '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed. Please try again.');
  if (result.csrf) state.session.csrf = result.csrf;
  return result;
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').className = `toast${error ? ' error' : ''}`;
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), error ? 10000 : 4500);
}

function route() { return location.hash.slice(1).split('?')[0] || 'home'; }
function adminPath(suffix = '') { return `/admin/events/${state.eventId}${suffix}`; }
function badge(status) {
  const styles = { claimed: 'green', approved: 'green', live: 'green', absent: 'grey', ended: 'grey', pending: '', open: '' };
  return `<span class="badge ${styles[status] || ''}">${escape(status)}</span>`;
}
function stat(value, label) { return `<div class="stat"><strong>${escape(value)}</strong><span>${escape(label)}</span></div>`; }
function field(name, label, value = '', type = 'text', attrs = '') {
  return `<label class="field">${escape(label)}<input name="${escape(name)}" type="${type}" value="${escape(value)}" ${attrs}></label>`;
}
function cutoffInput(iso) { return new Date(new Date(iso).getTime() + 330 * 60000).toISOString().slice(0, 16); }
function settingsFields(event) {
  return `<div class="form-grid">
    <div class="span-two">${field('title', 'Event title', event.title, 'text', 'required maxlength="160"')}</div>
    <div class="span-two">${field('signup_closes_at', 'Public registration closes (IST)', cutoffInput(event.signup_closes_at), 'datetime-local', 'required')}</div>
    <div class="span-two">${field('allowed_domains', 'Allowed signup email domains (comma-separated)', event.allowed_domains, 'text', 'required maxlength="500"')}</div>
    ${field('bonus_cap', 'Bonus-ticket cap per employee', event.bonus_cap, 'number', 'min="0" max="100" required')}
    ${field('prize_count', 'Number of prizes', event.prize_count, 'number', 'min="1" max="1000" required')}
  </div>`;
}

async function loadData() {
  state.data = await api(`/events/${state.eventId}/public`);
  state.me = state.session.personId ? await api('/me') : null;
  if (state.me && state.me.person.event_id !== state.eventId) state.me = null;
  state.admin = state.session.admin ? await api(adminPath()) : null;
  updateHeader();
}

function updateHeader() {
  $('#event-picker').innerHTML = state.events.map(e => `<option value="${e.id}" ${e.id === state.eventId ? 'selected' : ''}>${escape(e.id === state.eventId ? state.data.event.title : e.title)}</option>`).join('');
  $('#event-status').outerHTML = badge(state.data.event.status).replace('<span ', '<span id="event-status" ');
  $('#signout').classList.toggle('hidden', !state.session.admin && !state.session.personId);
  document.title = `${state.data.event.title} | Lucky Draw`;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === route()));
}

function activities(tasks, employee = false) {
  if (!tasks.length) return '<div class="notice">Activities will be announced by your coordinators.</div>';
  return `<div class="grid">${tasks.map((task, index) => `<article class="card">
    <div class="card-top"><span class="activity-number">${String(index + 1).padStart(2, '0')}</span>${employee && task.done ? badge('verified') : `<span class="badge">+${task.reward} ticket${task.reward === 1 ? '' : 's'}</span>`}</div>
    <h3>${escape(task.title)}</h3><p>${escape(task.description)}</p>
    ${employee ? `<p class="helper">${task.done ? 'Verified by your coordinator. Rewards are subject to the event bonus cap.' : 'Complete this activity and send your proof to an admin through Teams.'}</p>` : ''}
  </article>`).join('')}</div>`;
}

function renderHome() {
  const { event, stats, remaining, tasks } = state.data;
  const closed = event.status === 'ended' || Date.now() >= new Date(event.signup_closes_at).getTime();
  return `<section class="hero">
    <div><p class="eyebrow">Together is where the magic happens</p><h1>${escape(event.title)}</h1>
    <p>A celebration of our people, a little festive fun, and a chance to take home something special. Every approved signup starts with one lucky ticket.</p>
    <div class="actions"><a class="button" href="#employee">${state.me ? 'View my tickets' : closed ? 'Employee sign-in' : 'Join the celebration'} &rarr;</a><a class="button secondary" href="#draw">Watch the live draw</a></div>
    <p class="helper">${closed ? 'Public registration is closed. Admins can help with late entries.' : `Register by ${escape(date(event.signup_closes_at))}`}</p></div>
    <div class="ticket-art" aria-hidden="true"><div class="decorative-ticket"><div class="ticket-label">A LITTLE LUCK, JUST FOR YOU</div><div class="ticket-star">&#10022;</div><strong>YOUR NEXT BIG MOMENT</strong><div class="ticket-bottom"><span>ONE TEAM. MANY POSSIBILITIES.</span><span>01</span></div></div><p>PARTICIPATE &middot; CONNECT &middot; CELEBRATE</p></div>
  </section>
  <div class="stats">${stat(stats.participants, 'Approved participants')}${stat(stats.tickets, 'Tickets in the draw')}${stat(remaining, 'Prizes still available')}${stat(event.bonus_cap, 'Bonus tickets you can earn')}</div>
  <div class="section-heading"><div><p class="eyebrow">Make your participation count</p><h2>Small actions. More chances.</h2></div><p class="muted small">One base ticket + up to ${event.bonus_cap} bonus tickets</p></div>
  ${activities(tasks)}
  <div class="notice">Participation is voluntary, and onsite and remote employees are equally welcome. Each activity counts once. More tickets improve your chances but never guarantee a prize. An internal alternative is available for the LinkedIn activity.</div>
  <div class="section-heading"><h2>Your route to the draw</h2></div>
  <div class="steps"><div><span class="step-number">01 / JOIN</span><strong>Register and get approved</strong><p>Enter your name and work email. Your coordinator approves your entry and activates your base ticket.</p></div><div><span class="step-number">02 / PARTICIPATE</span><strong>Complete an activity</strong><p>Send proof through Teams. An admin verifies completion and assigns the corresponding bonus tickets.</p></div><div><span class="step-number">03 / CELEBRATE</span><strong>Be there for your moment</strong><p>Watch the draw online or onsite. Every active ticket has an equal chance, and each person can claim only one prize.</p></div></div>`;
}

function renderEmployee() {
  const { event } = state.data;
  if (!state.me) {
    const signup = state.authTab === 'signup';
    const closed = event.status === 'ended' || Date.now() >= new Date(event.signup_closes_at).getTime();
    return `<section class="auth-layout"><div class="auth-intro"><p class="eyebrow">Your celebration starts here</p><h1>One team.<br>A little more luck.</h1><p>Join with your name and email. Your coordinator will approve your entry, and you will be ready to earn tickets.</p><div class="notice">Allowed email domains: ${escape(event.allowed_domains)}<br>Registration deadline: ${escape(date(event.signup_closes_at))}</div><p class="small">This internal portal uses email-only access, not email verification. Do not enter sensitive information.</p></div>
    <div class="card auth-card"><div class="tabs"><button data-auth="signup" class="${signup ? 'active' : ''}">Register</button><button data-auth="login" class="${!signup ? 'active' : ''}">Employee sign-in</button></div>
    <h2>${signup ? 'Save your spot' : 'Welcome back'}</h2><p class="muted small">${signup ? 'Every entry is reviewed by an admin.' : 'Use the email address approved for this event.'}</p>
    ${signup && closed ? '<div class="notice">Public registration is closed. Contact an admin for a late entry, or sign in to your approved account.</div>' :
      `<form data-form="${signup ? 'signup' : 'employee-login'}">${signup ? field('name', 'Your name', '', 'text', 'required maxlength="100" autocomplete="name"') : ''}
      ${field('email', 'Email address', '', 'email', 'required maxlength="254" autocomplete="email"')}
      <button class="primary full" type="submit">${signup ? 'Register for the event' : 'View my tickets'} &rarr;</button></form>`}
    </div></section>`;
  }
  const { person, tickets, tasks, won } = state.me;
  const eligible = person.approved && !won;
  return `<div class="page-heading"><div><p class="eyebrow">Your festive dashboard</p><h1>Hello, ${escape(person.name)}.</h1><p>${escape(person.email)}</p></div>${badge(won ? 'winner' : person.approved ? 'approved' : 'pending approval')}</div>
    ${!person.approved ? '<div class="notice"><strong>Your registration is awaiting admin approval.</strong> Your entry is saved. Contact your coordinator through Teams; tickets become eligible after approval.</div>' : ''}
    ${won ? `<div class="notice green"><strong>Congratulations! You claimed ${escape(won)}.</strong> All your tickets are excluded from further draws in this event.</div>` : ''}
    <div class="stats">${stat(eligible ? tickets.length : 0, 'Eligible tickets')}${stat(1, 'Base ticket')}${stat(Math.max(0, tickets.length - 1), 'Allocated bonus tickets')}${stat(event.bonus_cap, 'Bonus-ticket cap')}</div>
    <div class="card"><h3>Your ticket wallet</h3><p>${eligible ? 'Each of these tickets is linked to your entry and has the same chance in the draw.' : 'Allocated ticket identifiers are shown below for your records; they are not currently eligible for selection.'}</p>
    <div class="ticket-list">${tickets.map(t => `<span class="mini-ticket">${ticketCode(t.id)} ${t.source_key === 'base' ? '/ BASE' : '/ BONUS'}</span>`).join('')}</div></div>
    <div class="section-heading"><div><p class="eyebrow">Get involved</p><h2>Your engagement activities</h2></div><p class="muted small">Send activity proofs to your admin on Teams.</p></div>
    ${activities(tasks, true)}<div class="notice">Missing a ticket or a completed activity? Contact your coordinator through Teams. Repeated participation in the same activity does not earn additional tickets. Bonus tickets are capped at ${event.bonus_cap}.</div>`;
}

function winnersList() {
  const wins = state.data.draws.filter(d => d.status === 'claimed').slice().reverse();
  return `<div class="card"><p class="eyebrow">The celebration roll</p><h3>Our lucky winners</h3>${wins.length ? wins.map((d, i) => `<div class="winner-item"><span class="winner-rank">${String(i + 1).padStart(2, '0')}</span><div><strong>${escape(d.name)}</strong><p>${escape(d.prize_label)} &middot; ${ticketCode(d.ticket_id)}</p></div></div>`).join('') : '<p>No prizes claimed yet. Your moment could be next.</p>'}</div>`;
}

function stage(admin = false) {
  const { event, draws, remaining } = state.data;
  const pending = draws.find(d => d.status === 'pending');
  const latest = draws[0];
  const visible = pending || latest;
  return `<div class="draw-stage" id="draw-stage"><p class="eyebrow">${escape(event.title)}</p>
    ${visible ? `<span class="badge">${pending ? 'Selected &middot; awaiting confirmation' : visible.status === 'claimed' ? 'Prize claimed &middot; congratulations!' : 'Not present &middot; still eligible'}</span><h2>${escape(visible.name)}</h2><div class="ticket-code">${ticketCode(visible.ticket_id)}</div><p>${escape(visible.prize_label)}</p>` :
      `<div class="orb" aria-hidden="true">&#10022;</div><h2>${event.status === 'ended' ? 'A celebration to remember.' : 'Your moment is coming.'}</h2><p>${event.status === 'live' ? 'The draw is live. Good luck, everyone!' : 'Grab a seat. The next lucky name could be yours.'}</p>`}
    ${pending && admin ? `<div class="actions"><button class="button success" data-resolve="${pending.id}" data-status="claimed">Present &amp; claimed</button><button class="button secondary" data-resolve="${pending.id}" data-status="absent">Absent &mdash; keep prize</button></div>` : ''}
    <p class="helper">${remaining} prize${remaining === 1 ? '' : 's'} remaining &middot; ${state.data.stats.tickets} eligible tickets</p>
  </div>`;
}

function renderDraw(admin = false) {
  const { event, remaining } = state.data;
  const pending = state.data.draws.some(d => d.status === 'pending');
  return `${!admin ? `<div class="page-heading"><div><p class="eyebrow">A shared moment of possibility</p><h1>The live lucky draw</h1><p>One fair draw. One prize per person. All eyes on the next name.</p></div><button class="secondary" data-action="fullscreen">Presentation mode &#8599;</button></div>` : ''}
    <div class="draw-layout"><div>${stage(admin)}
    ${admin ? `<form data-form="draw" class="card"><h3>Draw the next ticket</h3>${field('prize_label', 'Prize name for this selection', '', 'text', 'maxlength="160" placeholder="e.g. Festive gift hamper"')}<button class="primary full" type="submit" ${event.status !== 'live' || !remaining || pending ? 'disabled' : ''}>Select a lucky ticket &rarr;</button><p class="helper">${pending ? 'Confirm whether the selected employee is present before continuing.' : event.status !== 'live' ? 'Set the event status to Live in Settings before drawing.' : 'Selection uses cryptographically secure randomness across all eligible tickets.'}</p></form>` :
      '<p class="helper">This screen updates automatically. If selected, make yourself known to the coordinator. An absent selection does not consume a prize.</p>'}</div>${winnersList()}</div>
    <div class="notice">Only a confirmed claim uses a prize. An absent employee stays eligible for a later selection. Once a person claims a prize, all their tickets are excluded for the rest of this event.</div>
    ${admin ? `<div class="section-heading"><h3>Selection history</h3><a class="button secondary" href="/api${adminPath('/export')}">Export claimed winners (CSV)</a></div>${drawHistory()}` : ''}`;
}

function drawHistory() {
  return `<div class="table-wrap"><table><thead><tr><th>Selected employee</th><th>Prize</th><th>Ticket</th><th>Status</th><th>Selected at</th></tr></thead><tbody>${state.data.draws.map(d => `<tr><td>${escape(d.name)}</td><td>${escape(d.prize_label)}</td><td>${ticketCode(d.ticket_id)}</td><td>${badge(d.status)}</td><td>${escape(date(d.created_at))}</td></tr>`).join('') || '<tr><td colspan="5">No selections yet.</td></tr>'}</tbody></table></div>`;
}

function renderPeople() {
  const { people, tasks, completions } = state.admin;
  const person = people.find(p => p.id === state.personId);
  const ended = state.data.event.status === 'ended';
  return `<div class="section-heading"><div><h2>People &amp; verification</h2><p class="muted small">Approve entries and mark Teams-verified activities as done.</p></div><button class="secondary" data-action="refresh">Refresh entries</button></div>
    <div class="verification-layout"><div><label class="field">Find an employee<input id="people-search" type="search" placeholder="Search name or email" autocomplete="off"></label>
    <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Status</th><th>Tickets</th><th>Manage</th></tr></thead><tbody id="people-rows">${people.map(p => `<tr data-search="${escape(`${p.name} ${p.email}`.toLowerCase())}"><td><strong>${escape(p.name)}</strong><span class="small">${escape(p.email)}</span></td><td>${badge(p.won ? 'winner' : p.approved ? 'approved' : 'pending')}</td><td>${p.approved && !p.won ? p.ticket_count : 0}<span class="small">${p.ticket_count} allocated</span></td><td><button class="secondary" data-person="${p.id}">Manage</button></td></tr>`).join('') || '<tr><td colspan="4">No entries yet. Share the portal link to get started.</td></tr>'}</tbody></table></div>
    <details class="card"><summary>Add an employee (also after the cutoff)</summary><p class="helper">Admin-added entries are approved immediately and can use any email domain.</p><form data-form="add-person">${field('name', 'Name', '', 'text', 'required maxlength="100"')}${field('email', 'Email', '', 'email', 'required maxlength="254"')}<button class="primary" ${ended ? 'disabled' : ''}>Add approved employee</button></form></details></div>
    <aside class="card">${person ? `<p class="eyebrow">Employee verification</p><h3>${escape(person.name)}</h3><p>${escape(person.email)}</p><label class="check-row"><input type="checkbox" data-approve="${person.id}" ${person.approved ? 'checked' : ''} ${ended ? 'disabled' : ''}><span>Approved for this event</span></label>
    <p class="helper">Tick only after verifying activity evidence through Teams. Unticking reverses the ticket reward. The event cap applies automatically.</p>
    ${tasks.map(t => `<label class="check-row"><input type="checkbox" data-complete="${t.id}" data-owner="${person.id}" ${completions.some(c => c.person_id === person.id && c.task_id === t.id && c.done) ? 'checked' : ''} ${ended || !t.active ? 'disabled' : ''}><span>${escape(t.title)}${!t.active ? ' (inactive)' : ''}<br><small>+${t.reward} ticket${t.reward === 1 ? '' : 's'}</small></span></label>`).join('')}
    <form data-form="manual-bonus" data-owner="${person.id}">${field('extra_bonus', 'Additional admin bonus (subject to event cap)', person.extra_bonus, 'number', 'min="0" max="100" required')}<button class="secondary" ${ended ? 'disabled' : ''}>Save admin bonus</button></form>
    <div class="notice">${person.ticket_count} allocated tickets. ${person.won ? 'Already a claimed winner; no tickets are eligible.' : !person.approved ? 'Approval is needed before tickets are eligible.' : 'All active tickets are eligible until a prize is claimed.'}</div>` :
      '<p class="eyebrow">Keep it fair</p><h3>Every ticket starts with verification.</h3><p>Select an employee to approve their registration, verify activities, or adjust their admin bonus.</p><div class="notice">Activity completion is idempotent: marking Done twice never creates duplicate rewards.</div>'}</aside></div>`;
}

function renderTasks() {
  const ended = state.data.event.status === 'ended';
  const taskForm = task => `<form data-form="task" data-task="${task.id || ''}" class="card">
    ${field('title', 'Activity title', task.title || '', 'text', 'required maxlength="160"')}
    <label class="field">Instructions / participation window<textarea name="description" maxlength="2000">${escape(task.description || '')}</textarea></label>
    ${field('reward', 'Bonus tickets for completion', task.reward ?? 1, 'number', 'min="0" max="100" required')}
    <label class="check-row"><input type="checkbox" name="active" ${task.active !== false ? 'checked' : ''}><span>Activity is available</span></label>
    <p class="helper">Changing rewards or availability recalculates existing allocations under the event cap.</p><button class="primary" ${ended ? 'disabled' : ''}>${task.id ? 'Save activity' : 'Add activity'}</button></form>`;
  return `<div class="section-heading"><div><h2>Engagement activities</h2><p class="muted small">These starter activities are editable references. Proofs stay in Teams, not this portal.</p></div></div><div class="grid">${state.admin.tasks.map(taskForm).join('')}${taskForm({})}</div>`;
}

function renderSettings() {
  const event = state.data.event;
  return `<div class="two-col"><form data-form="settings" class="card"><h2>Event settings</h2>${settingsFields(event)}
    <label class="field">Event status<select name="status"><option value="open" ${event.status === 'open' ? 'selected' : ''}>Open - registration &amp; activities</option><option value="live" ${event.status === 'live' ? 'selected' : ''}>Live - draw enabled</option><option value="ended" ${event.status === 'ended' ? 'selected' : ''}>Ended - read-only archive</option></select></label>
    <div class="notice">Tickets can be updated while Open or Live. Ending an event locks its records permanently. Resolve any pending selection first.</div><button class="primary" ${event.status === 'ended' ? 'disabled' : ''}>Save event settings</button></form>
    <div><form data-form="new-event" class="card"><p class="eyebrow">Made for your next celebration</p><h2>Create a new event</h2><p class="muted small">Start fresh with demo tasks. Employees, tickets, and winners remain separate for every event.</p>${settingsFields({ ...event, title: 'Our next lucky draw', signup_closes_at: new Date(Date.now() + 7 * 86400000).toISOString() })}<button class="primary">Create new event</button></form>
    <div class="notice">Email-only employee access is intentionally lightweight: anyone who knows an approved address can open that employee dashboard. Admin actions always require the admin password.</div></div></div>`;
}

function renderAudit() {
  return `<div class="section-heading"><div><h2>Event audit trail</h2><p class="muted small">The latest 100 actions. Full history is preserved in PostgreSQL.</p></div></div><div class="table-wrap"><table><thead><tr><th>Time (IST)</th><th>Action</th><th>Details</th></tr></thead><tbody>${state.admin.auditLog.map(a => `<tr><td>${escape(date(a.created_at))}</td><td>${escape(a.action)}</td><td class="audit-details">${escape(JSON.stringify(a.details))}</td></tr>`).join('') || '<tr><td colspan="3">No actions recorded yet.</td></tr>'}</tbody></table></div>`;
}

function renderAdmin() {
  if (!state.session.admin) return `<section class="auth-layout"><div class="auth-intro"><p class="eyebrow">Behind every great celebration</p><h1>A little coordination.<br>A lot of joy.</h1><p>Your space to approve participants, verify activities, and run a transparent draw.</p><div class="notice">Admin credentials are configured privately by the portal owner. Employee email-only sign-in does not grant admin access.</div></div>
    <form data-form="admin-login" class="card auth-card"><h2>Coordinator sign-in</h2>${field('email', 'Admin email', '', 'email', 'required autocomplete="username"')}${field('password', 'Admin password', '', 'password', 'required autocomplete="current-password" maxlength="512"')}<button class="primary full">Sign in to admin &rarr;</button></form></section>`;
  const { people } = state.admin;
  const tabs = { people: 'People & tickets', tasks: 'Activities', draw: 'Run the draw', settings: 'Settings', audit: 'Audit trail' };
  return `<div class="page-heading"><div><p class="eyebrow">Coordinator workspace</p><h1>Make the celebration happen.</h1><p>${escape(state.data.event.title)}</p></div><a class="button secondary" href="?event=${state.eventId}#draw" target="_blank" rel="noopener">Open audience screen &#8599;</a></div>
    <div class="stats">${stat(people.length, 'Registered employees')}${stat(people.filter(p => !p.approved).length, 'Awaiting approval')}${stat(state.data.stats.tickets, 'Eligible tickets')}${stat(state.data.remaining, 'Prizes remaining')}</div>
    <div class="tabs" role="group" aria-label="Admin sections">${Object.entries(tabs).map(([key, label]) => `<button data-tab="${key}" class="${state.tab === key ? 'active' : ''}">${label}</button>`).join('')}</div>
    ${state.tab === 'people' ? renderPeople() : state.tab === 'tasks' ? renderTasks() : state.tab === 'draw' ? renderDraw(true) : state.tab === 'settings' ? renderSettings() : renderAudit()}`;
}

function render() {
  updateHeader();
  const page = route();
  $('#app').innerHTML = page === 'employee' ? renderEmployee() : page === 'admin' ? renderAdmin() : page === 'draw' ? renderDraw() : renderHome();
}

async function refresh() {
  await loadData();
  render();
}

async function action(callback) {
  if (state.busy) return;
  state.busy = true;
  const buttons = [...document.querySelectorAll('#app button')];
  buttons.forEach(b => { b.dataset.wasDisabled = String(b.disabled); b.disabled = true; });
  try { await callback(); }
  catch (error) { toast(error.message, true); }
  finally {
    state.busy = false;
    buttons.forEach(b => { if (b.isConnected) b.disabled = b.dataset.wasDisabled === 'true'; });
  }
}

document.addEventListener('submit', event => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  action(async () => {
    const body = Object.fromEntries(new FormData(form));
    const type = form.dataset.form;
    if (['settings', 'new-event'].includes(type)) {
      body.signup_closes_at += ':00+05:30';
      if (type === 'settings' && body.status === 'ended' && !confirm('End this event permanently? Records become read-only.')) return;
    }
    if (type === 'signup' || type === 'employee-login') {
      await api(`/events/${state.eventId}/${type === 'signup' ? 'signup' : 'login'}`, 'POST', body);
      state.session = await api('/session');
    } else if (type === 'admin-login') {
      await api('/admin/login', 'POST', body);
      state.session = await api('/session');
    } else if (type === 'settings') await api(adminPath(), 'PATCH', body);
    else if (type === 'new-event') {
      const newEvent = await api('/admin/events', 'POST', body);
      state.eventId = newEvent.id;
      state.personId = null;
      setEventUrl();
    } else if (type === 'task') {
      body.active = form.elements.active.checked;
      await api(adminPath(`/tasks${form.dataset.task ? `/${form.dataset.task}` : ''}`), form.dataset.task ? 'PATCH' : 'POST', body);
    } else if (type === 'add-person') await api(adminPath('/people'), 'POST', body);
    else if (type === 'manual-bonus') await api(adminPath(`/people/${form.dataset.owner}`), 'PATCH', body);
    else if (type === 'draw') await api(adminPath('/draw'), 'POST', body);
    state.events = await api('/events');
    await refresh();
    toast(type === 'signup' ? 'Registration saved. Your entry is awaiting admin approval.' : type === 'draw' ? 'A lucky ticket has been selected. Confirm attendance and claim.' : 'Saved successfully.');
  });
});

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.tab) { state.tab = button.dataset.tab; render(); }
  else if (button.dataset.auth) { state.authTab = button.dataset.auth; render(); }
  else if (button.dataset.person) { state.personId = Number(button.dataset.person); render(); }
  else if (button.dataset.resolve) action(async () => {
    if (button.dataset.status === 'claimed' && !confirm('Confirm this employee is present and has claimed this prize? They cannot win again in this event.')) return;
    await api(adminPath(`/draws/${button.dataset.resolve}/resolve`), 'POST', { status: button.dataset.status });
    await refresh();
    toast(button.dataset.status === 'claimed' ? 'Prize claimed. All tickets for this winner are now excluded.' : 'Marked absent. The prize remains available and the employee stays eligible.');
  });
  else if (button.dataset.action === 'refresh') action(refresh);
  else if (button.dataset.action === 'fullscreen') {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else $('#app').requestFullscreen?.().catch(() => toast('Presentation mode is unavailable in this browser.', true));
  } else if (button.id === 'signout') action(async () => {
    await api('/logout', 'POST');
    state.session = await api('/session');
    state.admin = null;
    state.me = null;
    await refresh();
    toast('Signed out.');
  });
});

document.addEventListener('change', event => {
  const input = event.target;
  if (input.id === 'event-picker') action(async () => {
    state.eventId = Number(input.value);
    state.personId = null;
    setEventUrl();
    await refresh();
  });
  else if (input.dataset.complete) action(async () => {
    try {
      await api(adminPath(`/people/${input.dataset.owner}/tasks/${input.dataset.complete}`), 'PUT', { done: input.checked });
      await refresh();
      toast('Activity verification and ticket allocation updated.');
    } catch (error) { input.checked = !input.checked; throw error; }
  });
  else if (input.dataset.approve) action(async () => {
    try {
      await api(adminPath(`/people/${input.dataset.approve}`), 'PATCH', { approved: input.checked });
      await refresh();
      toast('Employee approval updated.');
    } catch (error) { input.checked = !input.checked; throw error; }
  });
});

document.addEventListener('input', event => {
  if (event.target.id !== 'people-search') return;
  const query = event.target.value.toLowerCase();
  document.querySelectorAll('#people-rows tr[data-search]').forEach(row => row.classList.toggle('hidden', !row.dataset.search.includes(query)));
});

function setEventUrl() {
  const url = new URL(location.href);
  url.searchParams.set('event', state.eventId);
  history.replaceState(null, '', url);
}

window.addEventListener('hashchange', () => { if (state.data) { render(); window.scrollTo(0, 0); } });

async function initialize() {
  try {
    state.session = await api('/session');
    state.events = await api('/events');
    if (!state.events.length) throw new Error('No events are available yet.');
    const requested = Number(new URLSearchParams(location.search).get('event'));
    state.eventId = state.events.some(e => e.id === requested) ? requested : state.events[0].id;
    await refresh();
  } catch (error) {
    $('#app').innerHTML = `<div class="empty-state"><h1>We could not load the portal.</h1><p>${escape(error.message)}</p><button class="primary" data-action="reload">Try again</button></div>`;
    $('[data-action="reload"]').addEventListener('click', () => location.reload());
  }
}

setInterval(async () => {
  if (document.hidden || state.busy || !state.data) return;
  const page = route();
  if (page !== 'draw' && page !== 'employee' && !(page === 'admin' && state.tab === 'draw')) return;
  try {
    const data = await api(`/events/${state.eventId}/public`);
    const changed = JSON.stringify(data) !== JSON.stringify(state.data);
    state.data = data;
    if (page === 'employee' && state.session.personId) {
      const me = await api('/me');
      if (me.person.event_id !== state.eventId) return;
      const employeeChanged = JSON.stringify(me) !== JSON.stringify(state.me);
      state.me = me;
      if (changed || employeeChanged) render();
    } else if (changed && !$('#app input:focus')) render();
  } catch { /* Keep the last known screen during a temporary connection failure. */ }
}, 5000);

initialize();
