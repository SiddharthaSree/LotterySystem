const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(value)) + ' IST';
const ticketCode = id => `CSI-${String(id).padStart(6, '0')}`;
const state = { session: {}, events: [], eventId: null, data: null, me: null, admin: null, tab: 'people', personId: null, authTab: 'signup', winnerRound: 'all', busy: false };
let toastTimer;
let serverClock = { time: Date.now(), received: performance.now() };
let polling = false;
let lastPoll = 0;
let connectionLost = false;
let presentation = false;
let roundPage = 0;
const initializedCelebrations = new WeakSet();
const drumAudio = new Audio('/audio/drumroll.wav?v=crescendo');
const winnerAudio = new Audio('/audio/winner.wav?v=crescendo');
const drawAudio = [drumAudio, winnerAudio];
drawAudio.forEach(audio => { audio.preload = 'auto'; audio.volume = .9; });
let audioUnlocked = false;
let unlockingAudio = false;
let drumKey = null;
let soundStatus = 'Sound: click anywhere once to allow audio.';
const soundedWinners = new Set();
const winnerMessages = new Map();
const appreciationMessages = [
  'Thank you for your dedication to CSI. Your everyday effort helps our whole team move forward.',
  'Your ideas, kindness, and commitment make CSI a better place to work. Thank you for all you bring.',
  'Great teams grow through people who care. Thank you for supporting your colleagues and giving your best at CSI.',
  'Every thoughtful contribution makes a difference. Thank you for helping CSI build something meaningful together.',
  'Your hard work inspires the people around you. Keep learning, sharing, and shining. We are grateful you are part of CSI.',
];

function setSoundStatus(message) {
  soundStatus = message;
  const label = $('#sound-status');
  if (label && label.textContent !== message) label.textContent = message;
}

function audioFailure(error) {
  audioUnlocked = false;
  stopDrumroll();
  winnerAudio.pause();
  setSoundStatus(error.name === 'NotAllowedError' ?
    'Sound blocked: click this page and allow sound in your browser site settings.' :
    'Sound could not play. Check your connection, browser sound permission, and speaker volume.');
  toast(soundStatus, true);
}

async function unlockDrawAudio() {
  if (audioUnlocked || unlockingAudio) return;
  unlockingAudio = true;
  setSoundStatus('Preparing sound...');
  try {
    // Prime both media elements during the user's gesture for later server-timed reveals.
    await Promise.all(drawAudio.map(async audio => {
      audio.volume = 0;
      try { await audio.play(); }
      finally { audio.pause(); audio.currentTime = 0; audio.volume = .9; }
    }));
    audioUnlocked = true;
    setSoundStatus('Sound ready. If silent, unmute this tab and check speaker volume.');
    updateDrawSound();
  } catch (error) { audioFailure(error); }
  finally { unlockingAudio = false; }
}

document.addEventListener('click', unlockDrawAudio, { capture: true });
document.addEventListener('keydown', unlockDrawAudio, { capture: true });

function stopDrumroll() {
  drumAudio.pause();
  drumKey = null;
}

function startDrumroll(draw) {
  const key = `${state.eventId}:${draw.id}:${draw.reveal_ends_at}`;
  if (drumKey === key) return;
  stopDrumroll();
  const duration = state.data.reveal_duration_ms / 1000 - 1;
  const elapsed = Math.max(0, (serverNow() - draw.reveal_starts_at) / 1000);
  if (elapsed >= duration) return;
  drumAudio.currentTime = elapsed;
  drumKey = key;
  drumAudio.play().then(() => setSoundStatus('Playing drumroll. If silent, unmute this tab and check speaker volume.')).catch(audioFailure);
}

function updateDrawSound() {
  if (unlockingAudio) return;
  const onDraw = route() === 'draw' || (route() === 'admin' && state.tab === 'draw');
  if (!onDraw || !audioUnlocked || !state.data) {
    stopDrumroll();
    winnerAudio.pause();
    return;
  }
  const draw = state.data.draws.find(d => d.id === state.data.current_draw_id);
  if (!draw) { stopDrumroll(); return; }
  const now = serverNow();
  const celebrationAt = draw.reveal_ends_at - 1000;
  if (revealing(draw) && now >= draw.reveal_starts_at && now < celebrationAt) {
    startDrumroll(draw);
    return;
  }
  stopDrumroll();
  if (draw.status === 'claimed' && now >= celebrationAt && now - celebrationAt < 2000) {
    const key = `${state.eventId}:${draw.id}:${draw.reveal_ends_at}`;
    if (soundedWinners.has(key)) return;
    soundedWinners.add(key);
    winnerAudio.currentTime = Math.max(0, (now - celebrationAt) / 1000);
    winnerAudio.play().then(() => setSoundStatus('Playing winner fanfare.')).catch(audioFailure);
  }
}

async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-csrf-token': state.session.csrf || '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed. Please try again.');
  if (result.csrf) state.session.csrf = result.csrf;
  if (result.server_now) serverClock = { time: result.server_now, received: performance.now() };
  return result;
}

function serverNow() { return serverClock.time + performance.now() - serverClock.received; }
function revealing(draw) { return Boolean(draw) && draw.name === null; }

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').className = `toast${error ? ' error' : ''}`;
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), error ? 10000 : 4500);
}

function route() { return location.hash.slice(1).split('?')[0] || 'home'; }
function adminPath(suffix = '') { return `/admin/events/${state.eventId}${suffix}`; }
function badge(status) {
  const styles = { claimed: 'green', winner: 'green', approved: 'green', live: 'green', absent: 'grey', ended: 'grey', pending: '', open: '' };
  return `<span class="badge ${styles[status] || ''}">${escape(status === 'claimed' ? 'awarded' : status === 'absent' ? 'past unawarded selection' : status)}</span>`;
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
    ${field('bonus_cap', 'Bonus-ticket cap per employee', event.bonus_cap, 'number', 'min="0" max="100" required')}
    ${field('prize_count', 'Number of prizes', event.prize_count, 'number', `min="1" max="1000" required ${event.rounds_managed ? 'readonly' : ''}`)}
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
  $('#signout').textContent = state.session.admin ? 'Admin log out' : 'Log out';
  $('#employee-access').textContent = state.me ? 'My tickets' : 'Employee log in';
  $('#register-link').classList.toggle('hidden', Boolean(state.me || state.session.admin) || state.data.event.status === 'ended' || Date.now() >= new Date(state.data.event.signup_closes_at).getTime());
  $('#session-label').classList.toggle('hidden', !state.session.admin && !state.session.personId);
  $('#session-label').textContent = state.session.admin ? 'Signed in as coordinator' : state.me ? `Signed in: ${state.me.person.name}` : 'Employee session for another event';
  document.title = `${state.data.event.title} | Diwali Celebration Draw`;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === route()));
}

function activities(tasks, employee = false) {
  if (!tasks.length) return '<div class="notice">Activities will be announced by your coordinators.</div>';
  return `<div class="grid">${tasks.map((task, index) => `<article class="card">
    <div class="card-top"><span class="activity-number">${String(index + 1).padStart(2, '0')}</span>${employee && task.done ? badge('verified') : `<span class="badge">+${task.reward} ticket${task.reward === 1 ? '' : 's'}</span>`}</div>
    <h3>${escape(task.title)}</h3><p>${escape(task.description)}</p>
    ${employee ? `<p class="helper">${task.done ? 'Verified by your PM. Rewards are subject to the event bonus cap.' : 'Complete this activity within its announced window and send proof to your PM through Teams.'}</p>` : ''}
  </article>`).join('')}</div>`;
}

function renderHome() {
  const { event, stats, remaining, tasks } = state.data;
  const closed = event.status === 'ended' || Date.now() >= new Date(event.signup_closes_at).getTime();
  return `<section class="hero">
    <div><p class="eyebrow">Together is where the magic happens</p><h1>${escape(event.title)}</h1>
    <p>A celebration of our people, a little festive fun, and a chance to take home something special. Every employee gets one base ticket, even without activity participation. Your PM approves your entry for the draw.</p>
    <div class="actions"><a class="button" href="#employee">${state.me ? 'View my tickets' : closed ? 'Employee sign-in' : 'Join the celebration'} &rarr;</a><a class="button secondary" href="#draw">Watch the live draw</a></div>
    <p class="helper">${closed ? 'Public registration is closed. Admins can help with late entries.' : `Register by ${escape(date(event.signup_closes_at))}`}</p></div>
    <div class="ticket-art" aria-hidden="true"><div class="decorative-ticket"><div class="ticket-label">A LITTLE LUCK, JUST FOR YOU</div><div class="ticket-star">&#10022;</div><strong>YOUR NEXT BIG MOMENT</strong><div class="ticket-bottom"><span>ONE TEAM. MANY POSSIBILITIES.</span><span>01</span></div></div><p>PARTICIPATE &middot; CONNECT &middot; CELEBRATE</p></div>
  </section>
  <div class="stats">${stat(stats.participants, 'Approved participants')}${stat(stats.tickets, 'Tickets in the draw')}${stat(remaining, 'Prizes still available')}${stat(event.bonus_cap, 'Bonus tickets you can earn')}</div>
  ${state.data.rounds.length ? `<section class="prize-showcase"><div class="section-heading"><div><p class="eyebrow">A little luck. A lot to celebrate.</p><h2>${event.prize_count} prizes across ${state.data.rounds.length} rounds</h2></div><a class="button light" href="#draw">View rounds &amp; winners</a></div><div class="grid">${state.data.rounds.map(r => `<article class="card"><p class="eyebrow">Round ${r.position}</p><h3>${escape(r.name)}</h3><p>${escape(r.prize_label)}</p><strong>${r.winner_count} winners</strong><p>${r.batch_size || r.winner_count} winners per roll &middot; ${Math.ceil(r.winner_count / (r.batch_size || r.winner_count))} roll${r.winner_count > (r.batch_size || r.winner_count) ? 's' : ''}</p></article>`).join('')}</div></section>` : ''}
  <div class="section-heading"><div><p class="eyebrow">Make your participation count</p><h2>Small actions. More chances.</h2></div><p class="muted small">One base ticket + up to ${event.bonus_cap} bonus tickets = up to ${event.bonus_cap + 1} tickets</p></div>
  ${activities(tasks)}
  <div class="notice">Participation is voluntary, and onsite and remote employees are equally welcome. Each activity counts once. More tickets improve your chances but never guarantee a prize. An internal alternative is available for the LinkedIn activity.</div>
  <div class="section-heading"><h2>Your route to the draw</h2></div>
  <div class="steps"><div><span class="step-number">01 / JOIN</span><strong>Register and get approved</strong><p>Enter your name and email address. Department is optional. Your Project Manager (PM) approves your entry and activates your base ticket.</p></div><div><span class="step-number">02 / PARTICIPATE</span><strong>Complete an activity</strong><p>Follow each activity's date and eligibility rules, then send proof through Teams. Your PM verifies it and allocates the bonus ticket through administrator access. Celebration-day winners can be verified before the draw while the event is Open or Live.</p></div><div><span class="step-number">03 / CELEBRATE</span><strong>Celebrate your lucky moment</strong><p>Watch online or onsite, or check the winners later. Prizes are awarded even if you are offline. Each person can win only once per event.</p></div></div>`;
}

function renderEmployee() {
  const { event } = state.data;
  if (!state.me) {
    const signup = state.authTab === 'signup';
    const closed = event.status === 'ended' || Date.now() >= new Date(event.signup_closes_at).getTime();
    return `<section class="auth-layout"><div class="auth-intro"><p class="eyebrow">Your celebration starts here</p><h1>One team.<br>A little more luck.</h1><p>First visit? Register once. Already approved? Log in with the same email to see your tickets.</p><div class="notice">Any valid email address is accepted; PM approval is required.<br>Registration deadline: ${escape(date(event.signup_closes_at))}</div><p class="small">This internal portal uses email-only access, not email verification. Do not enter sensitive information.</p></div>
    <div class="card auth-card"><div class="tabs"><button data-auth="signup" class="${signup ? 'active' : ''}">Register</button><button data-auth="login" class="${!signup ? 'active' : ''}">Employee log in</button></div>
    <h2>${signup ? 'Save your spot' : 'Welcome back'}</h2><p class="muted small">${signup ? 'Every entry is reviewed by an admin.' : 'Use the email address approved for this event.'}</p>
    ${signup && closed ? '<div class="notice">Public registration is closed. Contact an admin for a late entry, or sign in to your approved account.</div>' :
      `<form data-form="${signup ? 'signup' : 'employee-login'}">${signup ? field('name', 'Your name', '', 'text', 'required maxlength="100" autocomplete="name"') : ''}
      ${field('email', 'Email address', '', 'email', 'required maxlength="254" autocomplete="email"')}
      ${signup ? field('department', 'Department (optional)', '', 'text', 'maxlength="80" placeholder="e.g. BU1, BU2 or HR"') : ''}
      <button class="primary full" type="submit">${signup ? 'Register for the event' : 'View my tickets'} &rarr;</button></form>`}
    </div></section>`;
  }
  const { person, tickets, tasks, won, winning_ticket_number: winningTicketId, award_pending: awardPending } = state.me;
  const messageKey = `${event.id}:${person.id}:${winningTicketId}`;
  if (won && !winnerMessages.has(messageKey)) {
    winnerMessages.set(messageKey, appreciationMessages[Math.floor(Math.random() * appreciationMessages.length)]);
  }
  const eligible = person.approved && !won && !awardPending;
  return `<div class="page-heading"><div><p class="eyebrow">Your festive dashboard</p><h1>Hello, ${escape(person.name)}.</h1><p>${escape(person.email)}</p></div>${badge(won ? 'winner' : person.approved ? 'approved' : 'pending approval')}</div>
    ${!person.approved ? '<div class="notice"><strong>Your registration is awaiting admin approval.</strong> Your entry is saved. Contact your coordinator through Teams; tickets become eligible after approval.</div>' : ''}
    ${won ? `<section class="golden-ticket" aria-label="Your golden winning ticket"><div><p class="ticket-ornament" aria-hidden="true">&#10022; &#10022; &#10022;</p><p class="eyebrow">CSI celebrates you</p><h2>Congratulations, ${escape(person.name)}!</h2><p class="golden-prize">You won ${escape(won)}.</p><blockquote>${escape(winnerMessages.get(messageKey))}</blockquote><p class="small">With appreciation, your CSI team</p></div><div class="golden-ticket-stub"><span>YOUR WINNING TICKET</span><strong>${ticketCode(winningTicketId)}</strong><div class="ticket-barcode" aria-hidden="true"></div><p>${escape(event.title)}</p></div><p class="golden-collection">Your prize is reserved. Contact your coordinator to collect it. One prize per person; your other tickets are excluded from further draws.</p></section>` : ''}
    ${awardPending ? '<div class="notice">A prize has been reserved for you. Watch the live draw for your ticket and name reveal. Your tickets are no longer eligible for another prize.</div>' : ''}
    <div class="stats">${stat(eligible ? tickets.length : 0, 'Eligible tickets')}${stat(1, 'Base ticket')}${stat(Math.max(0, tickets.length - 1), 'Allocated bonus tickets')}${stat(event.bonus_cap, 'Bonus-ticket cap')}</div>
    <div class="card"><h3>Your ticket wallet</h3><p>${eligible ? 'Each of these tickets is linked to your entry and has the same chance in the draw.' : 'Allocated ticket identifiers are shown below for your records; they are not currently eligible for selection.'}</p>
    <div class="ticket-list">${tickets.map(t => `<span class="mini-ticket">${ticketCode(t.ticket_number)} ${t.source_key === 'base' ? '/ BASE' : '/ BONUS'}</span>`).join('')}</div></div>
    <div class="section-heading"><div><p class="eyebrow">Get involved</p><h2>Your engagement activities</h2></div><p class="muted small">Send activity proofs to your PM on Teams.</p></div>
    ${activities(tasks, true)}<div class="notice">Missing a ticket or a completed activity? Contact your coordinator through Teams. Repeated participation in the same activity does not earn additional tickets. Bonus tickets are capped at ${event.bonus_cap}.</div>`;
}

function winnersList() {
  const wins = state.data.draws.filter(d => d.status === 'claimed' && !revealing(d)).slice().reverse();
  const rounds = state.data.rounds;
  const filtered = state.winnerRound === 'all' ? wins : wins.filter(d => String(d.round_id) === state.winnerRound);
  return `<div class="card" id="winners-list"><p class="eyebrow">The celebration roll</p><h3>Our lucky winners <span class="small">(${wins.length})</span></h3>
    ${rounds.length ? `<div class="tabs winner-tabs" role="group" aria-label="Filter winners by round"><button data-winner-round="all" aria-pressed="${state.winnerRound === 'all'}" class="${state.winnerRound === 'all' ? 'active' : ''}">All (${wins.length})</button>${rounds.map(r => `<button data-winner-round="${r.id}" title="${escape(r.name)}" aria-pressed="${state.winnerRound === String(r.id)}" class="${state.winnerRound === String(r.id) ? 'active' : ''}">Round ${r.position} (${wins.filter(d => d.round_id === r.id).length})</button>`).join('')}</div>` : ''}
    <div class="winner-grid" tabindex="0" role="region" aria-label="Scroll through all winners">${filtered.length ? filtered.map(d => `<div class="winner-item"><span class="winner-rank">${String(wins.indexOf(d) + 1).padStart(2, '0')}</span><div><strong>${escape(d.name)}</strong><p>${d.round_id ? `${escape(rounds.find(r => r.id === d.round_id)?.name || 'Round')} &middot; ` : ''}${escape(d.prize_label)} &middot; ${ticketCode(d.ticket_number)}</p></div></div>`).join('') : '<p>Winners will appear here as their tickets are revealed.</p>'}</div></div>`;
}

function stage() {
  const { event, draws, remaining, batch } = state.data;
  const visible = draws.find(d => d.id === state.data.current_draw_id) || draws[0];
  const rolling = revealing(visible);
  const celebrationAt = visible?.reveal_ends_at - 1000;
  const celebrate = visible?.status === 'claimed' && visible.reveal_ends_at > 0 &&
    serverNow() >= celebrationAt && serverNow() - celebrationAt < 5000;
  return `<div class="draw-stage" id="draw-stage">${celebrate ? confetti(celebrationAt) : ''}<p class="eyebrow">${escape(event.title)}</p>
    ${visible?.round_id ? `<p class="stage-round">${escape(state.data.rounds.find(r => r.id === visible.round_id)?.name || '')}</p>` : ''}
    ${batch ? `<p class="batch-progress">Winner ${batch.current_position} of ${batch.winner_count}${batch.requested_count > batch.winner_count ? ` &middot; ${batch.requested_count} requested; ${batch.winner_count} available` : ''}</p>` : ''}
    ${rolling ? `<div class="ticket-reveal" data-reveal="${visible.id}" aria-busy="true">
      <span class="badge">The lucky ticket is on its way</span><h2>Let the luck roll!</h2>
      <div class="ticket-reels" aria-hidden="true"><span class="reel-prefix">CSI</span>${String(visible.ticket_number).padStart(6, '0').split('').map(() => '<span class="reel-digit rolling">?</span>').join('')}</div>
      <div class="reveal-track" aria-hidden="true"><span id="reveal-progress"></span></div>
      <p id="reveal-message" role="status" aria-live="polite">Rolling the ticket numbers...</p>
      <p class="helper">Decorative animation &middot; the ticket is already randomly selected</p>
    </div><p>${escape(visible.prize_label)}</p>` :
      visible ? `<div class="winner-reveal" role="status"><span class="badge">${visible.status === 'claimed' ? 'Prize awarded &middot; congratulations!' : 'Past unawarded selection'}</span><h2>${escape(visible.name)}</h2><div class="ticket-code">${ticketCode(visible.ticket_number)}</div><p>${escape(visible.prize_label)}</p><p class="helper">${batch?.active ? 'The next winner will roll automatically...' : 'Winners can collect their prizes later.'}</p></div>` :
      `<div class="orb" aria-hidden="true">&#10022;</div><h2>${event.status === 'ended' ? 'A celebration to remember.' : 'Your moment is coming.'}</h2><p>${event.status === 'live' ? 'The draw is live. Good luck, everyone!' : 'Grab a seat. The next lucky name could be yours.'}</p>`}
    <p class="helper">${remaining} prize${remaining === 1 ? '' : 's'} remaining &middot; ${state.data.stats.tickets} eligible tickets</p>
  </div>`;
}

function confetti(timestamp) {
  return `<div class="confetti-burst" data-celebration="${timestamp}" aria-hidden="true">${'<i></i>'.repeat(60)}</div>`;
}

function drawHelp() {
  return state.data.batch?.active ? 'Revealing winners one by one. All selected prizes are already reserved.' :
    state.data.event.status !== 'live' ? 'Set the event status to Live in Settings before drawing.' :
      'Each winner gets a 10-second reveal, with a short pause before the next. If fewer prizes or employees remain, only the available number will be awarded.';
}

function renderDraw(admin = false) {
  const { event, remaining } = state.data;
  return `${!admin ? `<div class="page-heading"><div class="draw-heading"><img class="company-logo presentation-logo" src="/company-logo.png" alt="CSI Solution" width="1585" height="592"><div><p class="eyebrow">A shared moment of possibility</p><h1>Diwali Celebration Draw</h1><p>One fair draw. One prize per person. All eyes on the next name.</p></div></div><div class="actions">${resetDemoButton()}<button class="secondary" data-action="fullscreen">${presentation ? 'Exit presentation' : 'Presentation mode &#8599;'}</button></div></div>` : `<div class="actions">${resetDemoButton()}</div>`}
    <div class="draw-layout"><div class="draw-main">${stage()}<p class="sound-status" id="sound-status" role="status">${escape(soundStatus)}</p>
    ${state.data.rounds.length ? roundControls() : admin ? `<form data-form="draw" class="card"><h3>Roll for your next winners</h3>${field('prize_label', 'Prize name for this selection', '', 'text', 'maxlength="160" placeholder="e.g. Festive gift hamper"')}
      ${field('winner_count', 'Number of winners', 1, 'number', 'min="1" max="1000" required')}
      <button class="primary full" type="submit" ${event.status !== 'live' || !remaining || state.data.batch?.active || !state.data.stats.tickets ? 'disabled' : ''}>Roll &amp; reveal &rarr;</button><p class="helper" id="draw-roll-help">${drawHelp()}</p></form>` :
      '<p class="helper">This screen updates automatically. Each winning ticket is followed by the employee name. Winners keep their prize even if they are offline.</p>'}</div>${winnersList()}</div>
    <div class="notice">Every selected winner is automatically awarded one prize, which can be collected later. All other tickets belonging to a winner are excluded immediately, including within the same roll.</div>
    ${admin ? `<div class="section-heading"><h3>Selection history</h3><a class="button secondary" href="/api${adminPath('/export')}">Export winners (CSV)</a></div>${drawHistory()}` : ''}`;
}

function resetDemoButton() {
  return state.session.admin && state.data.event.is_demo ?
    `<button class="secondary" type="button" data-action="reset-demo" ${state.data.batch?.active ? 'disabled' : ''}>Reset demo</button>` : '';
}

function roundControls() {
  const { event, rounds, batch } = state.data;
  const next = rounds.find(round => !round.rolled_at);
  const pages = Math.max(1, Math.ceil(rounds.length / 3));
  roundPage = Math.min(roundPage, pages - 1);
  const shown = presentation ? rounds.slice(roundPage * 3, roundPage * 3 + 3) : rounds;
  const nextCount = next ? Math.min(next.batch_size || next.winner_count, next.winner_count - (next.awarded_count || 0)) : 0;
  const shortage = state.data.stats.eligible_employees < state.data.remaining;
  return `<section class="card round-controls" id="round-controls"><p class="eyebrow">Planned rounds</p>
    <div class="round-grid">${shown.map(round => `<div class="round-summary"><div><strong>${escape(round.name)}</strong><p>${escape(round.prize_label)} &middot; ${round.winner_count} planned winner${round.winner_count === 1 ? '' : 's'}</p>
      <p>${round.awarded_count || 0}/${round.winner_count} awarded &middot; ${round.rolls_completed || 0}/${Math.ceil(round.winner_count / (round.batch_size || round.winner_count))} rolls${round.rolled_at && round.awarded_count < round.winner_count ? ` &middot; ${round.winner_count - round.awarded_count} unfilled` : ''}</p></div>
      ${badge(round.rolled_at ? batch?.active && round.batch_id === batch.id ? 'revealing' : 'complete' : next?.id === round.id ? 'next' : 'upcoming')}</div>`).join('')}</div>
    ${presentation && pages > 1 ? `<div class="presentation-pages"><button class="secondary" data-round-page="-1" ${roundPage === 0 ? 'disabled' : ''}>Previous rounds</button><span>${roundPage + 1} / ${pages}</span><button class="secondary" data-round-page="1" ${roundPage === pages - 1 ? 'disabled' : ''}>Next rounds</button></div>` : ''}
    ${next ? `${state.session.admin ? `<button class="primary full" type="button" data-roll-round="${next.id}" ${event.status !== 'live' || batch?.active ? 'disabled' : ''}>Roll ${escape(next.name)} &mdash; ${nextCount} winners (roll ${(next.rolls_completed || 0) + 1}/${Math.ceil(next.winner_count / (next.batch_size || next.winner_count))}) &rarr;</button>` : ''}
      <p class="helper">${batch?.active ? 'Watch this roll finish revealing before the next roll.' : event.status !== 'live' ? 'The coordinator will start the event soon.' : `Next: ${escape(next.name)}. ${state.session.admin ? 'The saved prize and winner count will be used automatically.' : 'Waiting for the coordinator to roll.'}`}</p>
      ${state.session.admin ? `<p class="readiness ${shortage ? 'shortage' : ''}">${state.data.stats.eligible_employees} eligible employees for ${state.data.remaining} remaining prizes.${shortage ? ' Approve more employees before rolling; shortages are recorded as unfilled.' : ' Ready to fill all prizes.'}</p>` : ''}` :
      `<p class="notice green">${batch?.active ? 'The final round is revealing.' : 'All rounds are complete.'}</p>`}
    </section>`;
}

function roundRow(round = {}) {
  return `<div class="round-editor" data-round-row>
    ${field('round_name', 'Round name', round.name || '', 'text', 'required maxlength="160"')}
    ${field('round_prize', 'Round prize', round.prize_label || '', 'text', 'required maxlength="160"')}
    ${field('round_winners', 'Round winners', round.winner_count || 1, 'number', 'min="1" max="1000" required')}
    ${field('round_batch', 'Winners per roll', round.batch_size || round.winner_count || 1, 'number', 'min="1" max="1000" required')}
    <button class="secondary" type="button" data-action="remove-round">Remove round</button></div>`;
}

function roundPlanner() {
  const { event, draws, rounds } = state.data;
  const locked = event.status !== 'open' || event.rounds_locked_at || draws.length;
  return `<section class="card"><h2>Round planner</h2><p class="muted small">Set round names, prizes, total winners, and winners per roll. For example, 15 winners with 5 per roll means three rolls in that round. Each winner is revealed separately for 10 seconds. The total becomes the event prize count. Save before going Live; the plan then locks permanently.</p>
    ${locked ? `<div class="notice">The plan cannot be changed after going Live or after any draw. ${rounds.length ? 'Run the saved rounds from the public draw page while signed in as an admin.' : 'This event keeps its existing manual batch draw. Use a new event for planned rounds.'}</div>${rounds.length ? roundControls() : ''}` :
      `<form data-form="round-plan"><div id="round-editor-rows">${(rounds.length ? rounds : [{ name: 'Round 1', winner_count: 1 }]).map(roundRow).join('')}</div>
      <div class="actions"><button type="button" class="secondary" data-action="add-round">Add round</button><button class="primary">Save round plan</button></div><p class="helper">Maximum 100 rounds and 1000 total prizes. If a round has too few eligible employees, available winners are awarded and the remaining prizes are recorded as unfilled.</p></form>`}
  </section>`;
}

function drawHistory() {
  return `<div class="table-wrap"><table><thead><tr><th>Selected employee</th><th>Round / prize</th><th>Ticket</th><th>Status</th><th>Selected at</th></tr></thead><tbody>${state.data.draws.map(d => `<tr><td>${revealing(d) ? 'Reveal in progress...' : escape(d.name)}</td><td>${escape(state.data.rounds.find(r => r.id === d.round_id)?.name || '')}<span class="small">${escape(d.prize_label)}</span></td><td>${revealing(d) ? 'CSI-??????' : ticketCode(d.ticket_number)}</td><td>${badge(d.status)}</td><td>${escape(date(d.created_at))}</td></tr>`).join('') || '<tr><td colspan="5">No selections yet.</td></tr>'}</tbody></table></div>`;
}

function renderPeople() {
  const { people, tasks, completions } = state.admin;
  const person = people.find(p => p.id === state.personId);
  const ended = state.data.event.status === 'ended';
  return `<div class="section-heading"><div><h2>People &amp; verification</h2><p class="muted small">Approve entries and mark Teams-verified activities as done.</p></div><button class="secondary" data-action="refresh">Refresh entries</button></div>
    <div class="verification-layout"><div><label class="field">Find an employee<input id="people-search" type="search" placeholder="Search name, email or department" autocomplete="off"></label>
    <div class="table-wrap"><table><thead><tr><th>Employee / department</th><th>Status</th><th>Tickets</th><th>Manage</th></tr></thead><tbody id="people-rows">${people.map(p => `<tr data-search="${escape(`${p.name} ${p.email} ${p.department}`.toLowerCase())}"><td><strong>${escape(p.name)}</strong><span class="small">${escape(p.email)}</span><span class="small">${escape(p.department || 'Department not provided')}</span></td><td>${badge(p.won ? 'winner' : p.approved ? 'approved' : 'pending')}</td><td>${p.approved && !p.won ? p.ticket_count : 0}<span class="small">${p.ticket_count} allocated</span></td><td><button class="secondary" data-person="${p.id}">Manage</button></td></tr>`).join('') || '<tr><td colspan="4">No entries yet. Share the portal link to get started.</td></tr>'}</tbody></table></div>
    <details class="card"><summary>Add an employee (also after the cutoff)</summary><p class="helper">Admin-added entries are approved immediately and can use any email domain.</p><form data-form="add-person">${field('name', 'Name', '', 'text', 'required maxlength="100"')}${field('email', 'Email', '', 'email', 'required maxlength="254"')}${field('department', 'Department (optional)', '', 'text', 'maxlength="80" placeholder="e.g. BU1, BU2 or HR"')}<button class="primary" ${ended ? 'disabled' : ''}>Add approved employee</button></form></details></div>
    <aside class="card">${person ? `<p class="eyebrow">Employee verification</p><h3>${escape(person.name)}</h3><p>${escape(person.email)}</p><label class="check-row"><input type="checkbox" data-approve="${person.id}" ${person.approved ? 'checked' : ''} ${ended ? 'disabled' : ''}><span>Approved for this event</span></label>
    <form data-form="department" data-owner="${person.id}">${field('department', 'Department (optional)', person.department, 'text', 'maxlength="80" placeholder="e.g. BU1, BU2 or HR"')}<button class="secondary" ${ended ? 'disabled' : ''}>Save department</button><p class="helper">For coordinator reference only; not shown on the public draw.</p></form>
    <p class="helper">PMs: verify the activity rules and evidence through Teams before ticking Done. Quiz/game participation alone is not a win. Celebration-day tickets can be added before the draw while Open or Live. Unticking reverses the reward; the event cap applies automatically.</p>
    ${tasks.map(t => `<label class="check-row"><input type="checkbox" data-complete="${t.id}" data-owner="${person.id}" ${completions.some(c => c.person_id === person.id && c.task_id === t.id && c.done) ? 'checked' : ''} ${ended || !t.active ? 'disabled' : ''}><span>${escape(t.title)}${!t.active ? ' (inactive)' : ''}<br><small>+${t.reward} ticket${t.reward === 1 ? '' : 's'}</small></span></label>`).join('')}
    <form data-form="manual-bonus" data-owner="${person.id}">${field('extra_bonus', 'Additional admin bonus (subject to event cap)', person.extra_bonus, 'number', 'min="0" max="100" required')}<button class="secondary" ${ended ? 'disabled' : ''}>Save admin bonus</button></form>
    <div class="notice">${person.ticket_count} allocated tickets. ${person.won ? 'Already a winner; no tickets are eligible.' : !person.approved ? 'Approval is needed before tickets are eligible.' : 'All active tickets are eligible until a prize is awarded.'}</div>` :
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
  const active = state.admin.tasks.filter(task => task.active);
  const inactive = state.admin.tasks.filter(task => !task.active);
  return `<div class="section-heading"><div><h2>Engagement activities</h2><p class="muted small">PMs verify the rules and participation windows below. Proofs stay in Teams, not this portal. Inactive activities do not earn tickets.</p></div></div><div class="grid">${active.map(taskForm).join('')}${taskForm({})}</div>
    ${inactive.length ? `<details class="card"><summary>Inactive activities / historical records (${inactive.length})</summary><p class="helper">Retained for reference only. These instructions may describe a previous schedule and are not current eligibility rules.</p><div class="grid">${inactive.map(taskForm).join('')}</div></details>` : ''}`;
}

function renderSettings() {
  const event = state.data.event;
  return `${roundPlanner()}<div class="two-col"><form data-form="settings" class="card"><h2>Event settings</h2>${settingsFields({ ...event, rounds_managed: state.data.rounds.length > 0 })}
    <label class="field">Event status<select name="status"><option value="open" ${event.status === 'open' ? 'selected' : ''}>Open - registration &amp; activities</option><option value="live" ${event.status === 'live' ? 'selected' : ''}>Live - draw enabled</option><option value="ended" ${event.status === 'ended' ? 'selected' : ''}>Ended - read-only archive</option></select></label>
    <div class="notice">Tickets can be updated while Open or Live. Ending an event locks its records permanently. Wait for any winner reveals to finish first.</div><button class="primary" ${event.status === 'ended' ? 'disabled' : ''}>Save event settings</button></form>
    <div><form data-form="new-event" class="card"><p class="eyebrow">Made for your next celebration</p><h2>Create a new event</h2><p class="muted small">Start fresh with demo tasks. Save a round plan in Settings after creating the event, before going Live.</p>${settingsFields({ ...event, title: 'Our next lucky draw', signup_closes_at: new Date(Date.now() + 7 * 86400000).toISOString() })}<button class="primary">Create new event</button></form>
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
  const winnersScroll = $('.winner-grid')?.scrollTop || 0;
  updateHeader();
  $('#app').classList.toggle('presentation', presentation);
  const page = route();
  $('#app').innerHTML = page === 'employee' ? renderEmployee() : page === 'admin' ? renderAdmin() : page === 'draw' ? renderDraw() : renderHome();
  if ($('.winner-grid')) $('.winner-grid').scrollTop = winnersScroll;
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
    let drawResult;
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
    else if (type === 'round-plan') {
      body.rounds = [...form.querySelectorAll('[data-round-row]')].map(row => ({
        name: row.querySelector('[name="round_name"]').value,
        prize_label: row.querySelector('[name="round_prize"]').value,
        winner_count: row.querySelector('[name="round_winners"]').value,
        batch_size: row.querySelector('[name="round_batch"]').value,
      }));
      await api(adminPath('/rounds'), 'PUT', { rounds: body.rounds });
    }
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
    else if (type === 'department') await api(adminPath(`/people/${form.dataset.owner}`), 'PATCH', body);
    else if (type === 'draw') drawResult = await api(adminPath('/draw'), 'POST', body);
    state.events = await api('/events');
    await refresh();
    toast(type === 'signup' ? 'Registration saved. Your entry is awaiting admin approval.' :
      drawResult ? `${drawResult.winner_count} prize${drawResult.winner_count === 1 ? '' : 's'} awarded${drawResult.reduced ? ` (${drawResult.requested_count} requested; only ${drawResult.winner_count} available)` : ''}. Watch the winners reveal one by one.` : 'Saved successfully.');
  });
});

document.addEventListener('click', event => {
  const access = event.target.closest('[data-employee-auth]');
  if (access) {
    state.authTab = access.dataset.employeeAuth;
    if (state.data && route() === 'employee') render();
  }
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.tab) { state.tab = button.dataset.tab; render(); }
  else if (button.dataset.auth) { state.authTab = button.dataset.auth; render(); }
  else if (button.dataset.person) { state.personId = Number(button.dataset.person); render(); }
  else if (button.dataset.roundPage) { roundPage += Number(button.dataset.roundPage); render(); }
  else if (button.dataset.winnerRound) { state.winnerRound = button.dataset.winnerRound; render(); }
  else if (button.dataset.action === 'reset-demo') action(async () => {
    if (!confirm('Reset this demo? Its winners and round progress will be cleared. Employees, tickets, and round settings stay unchanged. Real events are not affected.')) return;
    await api(adminPath('/reset-demo'), 'POST', { confirm: true });
    roundPage = 0;
    await refresh();
    toast('Demo reset. Ready to roll Round 1 again.');
  });
  else if (button.dataset.rollRound) action(async () => {
    const result = await api(adminPath(`/rounds/${button.dataset.rollRound}/roll`), 'POST', {});
    await refresh();
    toast(`${result.round_name}: ${result.winner_count} awarded of ${result.requested_count} planned${result.reduced ? `; ${result.requested_count - result.winner_count} unfilled` : ''}.`);
  });
  else if (button.dataset.action === 'add-round') {
    const count = document.querySelectorAll('[data-round-row]').length;
    if (count >= 100) return toast('An event can have at most 100 rounds.', true);
    $('#round-editor-rows').insertAdjacentHTML('beforeend', roundRow({ name: `Round ${count + 1}` }));
  }
  else if (button.dataset.action === 'remove-round') {
    if (document.querySelectorAll('[data-round-row]').length <= 1) return toast('Keep at least one round in the plan.', true);
    button.closest('[data-round-row]').remove();
  }
  else if (button.dataset.action === 'refresh') action(refresh);
  else if (button.dataset.action === 'fullscreen') {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => toast('Could not exit presentation mode. Press Escape.', true));
    else if ($('#app').requestFullscreen) $('#app').requestFullscreen().catch(() => toast('Presentation mode is unavailable in this browser.', true));
    else toast('Presentation mode is unavailable in this browser.', true);
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
    state.winnerRound = 'all';
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

setInterval(() => {
  updateDrawSound();
  const activeReveal = $('[data-reveal]');
  const activeDraw = state.data?.draws.find(draw => String(draw.id) === activeReveal?.dataset.reveal);
  if (activeDraw && activeDraw.status === 'claimed' && serverNow() >= activeDraw.reveal_ends_at - 1000 &&
      serverNow() < activeDraw.reveal_ends_at + 4000 && !$('#draw-stage .confetti-burst')) {
    $('#draw-stage').insertAdjacentHTML('afterbegin', confetti(activeDraw.reveal_ends_at - 1000));
  }
  document.querySelectorAll('[data-celebration]').forEach(layer => {
    if (initializedCelebrations.has(layer)) return;
    initializedCelebrations.add(layer);
    const elapsed = Math.max(0, serverNow() - Number(layer.dataset.celebration));
    layer.getAnimations({ subtree: true }).forEach(animation => { animation.currentTime = elapsed; });
  });
  const container = $('[data-reveal]');
  if (!container || !state.data) return;
  const draw = state.data.draws.find(d => String(d.id) === container.dataset.reveal);
  if (!draw) return;
  const duration = state.data.reveal_duration_ms;
  const elapsed = Math.max(0, duration - (draw.reveal_ends_at - serverNow()));
  const digits = String(draw.ticket_number).padStart(6, '0');
  const fixed = Math.min(digits.length, Math.max(0, Math.floor((elapsed - 3000) / (6000 / digits.length))));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  container.querySelectorAll('.reel-digit').forEach((digit, index) => {
    const settled = index < fixed;
    digit.textContent = settled ? digits[index] : reducedMotion ? '?' : String(Math.floor(Math.random() * 10));
    digit.classList.toggle('rolling', !settled);
    digit.classList.toggle('settled', settled);
  });
  $('#reveal-progress').style.width = `${Math.min(100, elapsed / duration * 100)}%`;
  const message = elapsed < 3000 ? 'Rolling the ticket numbers...' : elapsed < duration - 1000 ? 'Revealing your lucky ticket...' : 'Your lucky ticket! Get ready to meet the winner...';
  if ($('#reveal-message').textContent !== message) $('#reveal-message').textContent = message;
}, 100);

async function pollLiveData() {
  if (state.busy || polling || !state.data) return;
  const page = route();
  if (page !== 'draw' && page !== 'employee' && !(page === 'admin' && state.tab === 'draw')) return;
  // Audience windows must keep following the draw while the coordinator uses another tab.
  if (document.hidden && page === 'employee') return;
  if (page === 'employee' && Date.now() - lastPoll < 5000) return;
  polling = true;
  lastPoll = Date.now();
  const eventId = state.eventId;
  try {
    const data = await api(`/events/${eventId}/public`);
    if (eventId !== state.eventId) return;
    const changed = JSON.stringify({ ...data, server_now: 0 }) !== JSON.stringify({ ...state.data, server_now: 0 });
    state.data = data;
    if (page === 'employee' && state.session.personId) {
      const me = await api('/me');
      if (me.person.event_id !== state.eventId) return;
      const employeeChanged = JSON.stringify(me) !== JSON.stringify(state.me);
      state.me = me;
      if (changed || employeeChanged) render();
    } else if (changed) {
      const input = $('#app input:focus');
      if (!input) render();
      else if ($('#draw-stage')) {
        $('#draw-stage').outerHTML = stage();
        const winnersScroll = $('.winner-grid').scrollTop;
        $('#winners-list').outerHTML = winnersList();
        $('.winner-grid').scrollTop = winnersScroll;
        if ($('#round-controls')) $('#round-controls').outerHTML = roundControls();
        const roll = $('[data-form="draw"] button');
        if (roll) {
          roll.disabled = state.data.event.status !== 'live' || !state.data.remaining || state.data.batch?.active || !state.data.stats.tickets;
          $('#draw-roll-help').textContent = drawHelp();
        }
        const history = $('#app .table-wrap');
        if (page === 'admin' && history) history.outerHTML = drawHistory();
      }
    }
    if (connectionLost) toast('Live connection restored.');
    connectionLost = false;
  } catch {
    if (!connectionLost) toast('Live updates interrupted. Reconnecting automatically; keep this screen open.', true);
    connectionLost = true;
  } finally { polling = false; }
}

setInterval(pollLiveData, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollLiveData();
});
window.addEventListener('focus', pollLiveData);
document.addEventListener('fullscreenchange', () => {
  presentation = document.fullscreenElement === $('#app');
  roundPage = Math.max(0, Math.floor((state.data?.rounds.findIndex(round => !round.rolled_at) || 0) / 3));
  if (state.data) render();
});

initialize();
