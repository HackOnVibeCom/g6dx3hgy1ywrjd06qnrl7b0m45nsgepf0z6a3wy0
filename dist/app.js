import { mountJourney } from './journey.mjs';
import { cents, share, qualify, results, budgetBand } from './domain.mjs';

const $ = selector => document.querySelector(selector);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = value => usd.format(value / 100);
const storeKey = 'inbudget-local-v1';
const date = value => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(value + 'T12:00:00'));
const demo = {
  title: 'The Asheville shortlist', start: '2026-10-15', end: '2026-10-18', payers: 4, demo: true,
  quotes: [{ name: 'Fern Hollow Cabin', total: 44001 }, { name: 'Ridge House', total: 56800 }, { name: 'The Laurel Lodge', total: 71600 }],
  responses: [[true, true, false], [true, true, true], [true, true, false]]
};

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey));
    if (saved?.quotes?.length && Array.isArray(saved.responses)) return saved;
  } catch {}
  return structuredClone(demo);
}

let round = load();
let privateLimit = round.demo && Number.isInteger(round.you) ? round.you : null;
let activeQuote = 0;
let remote = null;
const sharedId = new URLSearchParams(location.search).get('round');
function save() {
  try {
    localStorage.setItem(storeKey, JSON.stringify(round));
    return true;
  } catch { return false; }
}

const server = { ready: null, shared: false };
function serverReady() {
  if (!server.ready) {
    server.ready = fetch('/api/health')
      .then(async response => {
        const data = await response.json().catch(() => null);
        server.shared ||= typeof data?.ok === 'boolean';
        if (data?.staySearch) configureStaySearch(data.staySearch);
        return response.ok && data?.ok === true;
      })
      .catch(() => false)
      .then(ready => {
        if (!ready && server.shared) server.ready = null;
        return ready;
      });
  }
  return server.ready;
}

async function api(path, options = {}) {
  const response = await fetch('/api' + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || 'The round server could not complete that request.');
    error.status = response.status;
    throw error;
  }
  return data;
}

const hostStoreKey = id => 'inbudget-host-' + id;
const travelerStoreKey = id => 'inbudget-traveler-' + id;
function storedHostKey(id) {
  try { return localStorage.getItem(hostStoreKey(id)); } catch { return null; }
}
function storeHostKey(id, key) {
  try { localStorage.setItem(hostStoreKey(id), key); } catch {}
}
const answeredStoreKey = id => 'inbudget-answered-' + id;
function markedAnswered(id) {
  try { return localStorage.getItem(answeredStoreKey(id)) === '1'; } catch { return false; }
}
function markAnswered(id) {
  try { localStorage.setItem(answeredStoreKey(id), '1'); } catch {}
}
function unmarkAnswered(id) {
  try { localStorage.removeItem(answeredStoreKey(id)); } catch {}
}
const limitStoreKey = id => 'inbudget-limit-' + id;
function storedLimit(id) {
  try {
    const raw = localStorage.getItem(limitStoreKey(id));
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch { return null; }
}
function storeLimit(id, value) {
  try { localStorage.setItem(limitStoreKey(id), String(value)); } catch {}
}
const nameStoreKey = id => 'inbudget-name-' + id;
function storedName(id) {
  try { return localStorage.getItem(nameStoreKey(id)) || ''; } catch { return ''; }
}
function storeName(id, name) {
  try {
    if (name) localStorage.setItem(nameStoreKey(id), name);
    else localStorage.removeItem(nameStoreKey(id));
  } catch {}
}
function forgetAnswer(id) {
  try {
    localStorage.removeItem(answeredStoreKey(id));
    localStorage.removeItem(limitStoreKey(id));
    localStorage.removeItem(nameStoreKey(id));
  } catch {}
}
const hostListKey = 'inbudget-hosts-v1';
function readHosts() {
  try {
    const list = JSON.parse(localStorage.getItem(hostListKey));
    return Array.isArray(list)
      ? list.filter(item => item && typeof item.id === 'string' && /^[A-Za-z0-9_-]{12,40}$/.test(item.id))
      : [];
  } catch { return []; }
}
function writeHosts(list) {
  try { localStorage.setItem(hostListKey, JSON.stringify(list.slice(0, 12))); } catch {}
}
function rememberHost(round) {
  const list = readHosts();
  const item = { id: round.id, title: round.title, count: round.responseCount,
    payers: round.payers, previous: round.previousRoundId, successor: round.successorRoundId,
    superseded: round.superseded };
  const index = list.findIndex(entry => entry.id === item.id);
  if (index === -1) list.unshift(item);
  else list[index] = item;
  writeHosts(list);
}
function forgetHost(id) {
  writeHosts(readHosts().filter(item => item.id !== id));
}
function travelerToken(id) {
  let token = null;
  try { token = localStorage.getItem(travelerStoreKey(id)); } catch {}
  if (!token) {
    token = crypto.randomUUID ? crypto.randomUUID().replaceAll('-', '') : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(travelerStoreKey(id), token); } catch {}
  }
  return token;
}

function remoteStamp(payload) {
  return JSON.stringify([payload.responseCount, payload.results, payload.names, payload.superseded, payload.successorRoundId]);
}
function listPeople(parts) {
  if (parts.length < 2) return parts[0] || '';
  if (parts.length === 2) return parts[0] + ' and ' + parts[1];
  return parts.slice(0, -1).join(', ') + ', and ' + parts[parts.length - 1];
}
function whoAnswered(names, count) {
  const unnamed = Math.max(0, count - names.length);
  const parts = names.slice();
  if (unnamed === 1) parts.push('someone unnamed');
  else if (unnamed > 1) parts.push(unnamed + ' unnamed travelers');
  if (!parts.length) return '';
  const singular = parts.length === 1 && unnamed < 2;
  return listPeople(parts) + (singular ? ' has answered.' : ' have answered.');
}
function outcome() {
  return remote ? remote.results : results(round.quotes, round.responses, round.payers);
}
function answered() {
  return remote ? remote.count : round.responses.length;
}
function applyRemote(payload, hostKey) {
  round = { title: payload.title, start: payload.start, end: payload.end, payers: payload.payers,
    quotes: payload.quotes, destination: payload.destination, radius: payload.radius, demo: false };
  remote = {
    id: payload.id,
    hostKey: hostKey || (remote?.id === payload.id && remote.hostKey) || storedHostKey(payload.id),
    count: payload.responseCount,
    results: payload.results,
    names: Array.isArray(payload.names) ? payload.names : [],
    previous: payload.previousRoundId,
    successor: payload.successorRoundId,
    superseded: Boolean(payload.superseded),
    stamp: remoteStamp(payload)
  };
  if (payload.responseCount === 0) unmarkAnswered(payload.id);
  if (hostKey) storeHostKey(payload.id, hostKey);
  if (remote.hostKey) rememberHost(payload);
  const credit = document.querySelector('.footer > span');
  if (credit) credit.textContent = 'Shared round · answers stay private';
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function nightCount(start = round.start, end = round.end) {
  const n = Math.round((Date.parse(end) - Date.parse(start)) / 86400000);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}
function perPerson(quote) {
  return share(quote.total, round.payers);
}
function splitBreakdown({ high, low, highCount, lowCount }) {
  return `${highCount} × ${money(high)} + ${lowCount} × ${money(low)}`;
}
function shareLabel(split) {
  return split.highCount ? 'max per person' : 'per person';
}
function price(quote) {
  return money(perPerson(quote).high);
}
function perNight(quote) {
  return money(Math.round(perPerson(quote).high / nightCount()));
}
function knownLimit() {
  if (remote) return markedAnswered(remote.id) ? storedLimit(remote.id) : null;
  return round.demo ? privateLimit : null;
}
function canRevise() {
  if (remote) return !remote.superseded && markedAnswered(remote.id) && answered() > 0;
  return round.demo && privateLimit !== null && answered() >= round.payers;
}
function canAnswer() {
  return !remote?.superseded && (answered() < round.payers || canRevise());
}
function answerLabel() {
  if (round.demo) return canRevise() ? 'Change your answer' : 'Try the final response';
  if (canRevise()) return 'Update your answer';
  return 'Enter response ' + (answered() + 1);
}
function labelAction(button, label) {
  const arrow = element('span', 'arrow');
  arrow.setAttribute('aria-hidden', 'true');
  button.replaceChildren(document.createTextNode(label + ' '), arrow);
}
function appendBandSummary(target, range) {
  if (!range || (range.blocked !== null && range.covered > range.blocked)) {
    target.append('These answers don’t follow a single shared ceiling.');
  } else if (range.blocked === null) {
    target.append('Every traveler can cover ', element('strong', '', money(range.covered)), ', the highest share.');
  } else if (range.covered === 0) {
    target.append('The tightest budget is under ', element('strong', '', money(range.blocked)), '.');
  } else {
    target.append('The tightest budget covers ', element('strong', '', money(range.covered)), ' and stops short of ', element('strong', '', money(range.blocked)), '.');
  }
}
function focusBestFit() {
  const verdict = outcome();
  if (!verdict || verdict[activeQuote]) return;
  let best = -1;
  round.quotes.forEach((q, idx) => {
    if (verdict[idx] && (best < 0 || q.total > round.quotes[best].total)) best = idx;
  });
  if (best >= 0) activeQuote = best;
}
function showInsight() {
  const verdict = outcome();
  const band = $('#band');
  const studioVerdict = $('#studio-verdict');
  const personal = $('#personal');
  if (!verdict) {
    band.hidden = true;
    band.replaceChildren();
    if (studioVerdict) {
      studioVerdict.hidden = true;
      studioVerdict.replaceChildren();
      delete studioVerdict.dataset.tone;
    }
  } else {
    const range = budgetBand(round.quotes, round.payers, verdict);
    band.hidden = false;
    band.replaceChildren();
    appendBandSummary(band, range);
    if (studioVerdict) {
      const fits = verdict.filter(Boolean).length;
      const total = round.quotes.length;
      const lead = fits === 0
        ? 'No stays fit everyone · '
        : fits === total
          ? 'All ' + total + (total === 1 ? ' stay fits everyone · ' : ' stays fit everyone · ')
          : fits + ' of ' + total + ' stays fit everyone · ';
      studioVerdict.hidden = false;
      studioVerdict.dataset.tone = fits > 0 ? 'fit' : 'none';
      studioVerdict.replaceChildren(element('strong', 'verdict-lead', lead));
      appendBandSummary(studioVerdict, range);
    }
  }
  const mine = knownLimit();
  if (mine === null) {
    personal.hidden = true;
    personal.textContent = '';
    return;
  }
  const names = round.quotes.filter(quote => perPerson(quote).high <= mine).map(quote => quote.name);
  personal.hidden = false;
  if (!names.length) personal.textContent = 'Only on this device: your ' + money(mine) + ' is under every share.';
  else if (names.length === round.quotes.length) personal.textContent = 'Only on this device: your ' + money(mine) + ' covers every stay.';
  else personal.textContent = 'Only on this device: your ' + money(mine) + ' covers ' + names.join(', ') + '.';
}

function renderPriceTrack(verdict) {
  const track = $('#price-track');
  if (!track) return;
  if (round.quotes.length < 2) {
    track.hidden = true;
    return;
  }
  track.hidden = false;
  const items = round.quotes
    .map((q, index) => ({ quote: q, index, need: perPerson(q).high, fit: verdict?.[index] }))
    .sort((a, b) => a.need - b.need || a.index - b.index);
  const minNeed = items[0].need;
  const maxNeed = items[items.length - 1].need;
  const span = maxNeed - minNeed;
  const posOf = (item, rank) => (span > 0 ? ((item.need - minNeed) / span) * 100 : (rank / (items.length - 1)) * 100);

  let zoneEnd = 0;
  if (verdict) {
    items.forEach((item, rank) => {
      if (item.fit) zoneEnd = Math.max(zoneEnd, posOf(item, rank));
    });
    if (verdict.every(Boolean)) zoneEnd = 100;
  }
  track.dataset.verdict = verdict ? (verdict.some(Boolean) ? 'fit' : 'none') : 'pending';
  track.style.setProperty('--zone-end', zoneEnd.toFixed(2) + '%');

  const rail = element('div', 'track-rail');
  rail.setAttribute('aria-hidden', 'true');
  rail.append(element('span', 'track-zone'));

  const stops = element('div', 'track-stops');
  items.forEach((item, rank) => {
    const stop = element('button', 'track-stop');
    stop.type = 'button';
    stop.dataset.index = String(item.index);
    stop.style.setProperty('--pos', posOf(item, rank).toFixed(2) + '%');
    stop.setAttribute('aria-pressed', String(item.index === activeQuote));
    if (verdict) stop.dataset.fit = String(Boolean(item.fit));
    stop.append(element('strong', '', money(item.need)), element('span', '', item.quote.name));
    stop.onclick = () => selectQuote(item.index);
    stops.append(stop);
  });
  track.replaceChildren(rail, stops);
}

function buildSummaryText() {
  const verdict = outcome();
  if (!verdict) return '';
  const nights = nightCount();
  const header = `${round.title} (${date(round.start)}–${date(round.end)} · ${nights} ${nights === 1 ? 'night' : 'nights'} · ${round.payers} travelers)`;
  const winners = round.quotes.filter((_, idx) => verdict[idx]);
  if (!winners.length) return `${header} — None of the ${round.quotes.length} stays fit every budget.`;
  const list = winners.map(quote => {
    const split = perPerson(quote);
    const shares = split.highCount ? splitBreakdown(split) : `${money(split.high)}/person`;
    return `${quote.name} (${shares} · ${money(quote.total)} total)`;
  }).join(', ');
  return `${header} — ${winners.length} of ${round.quotes.length} stays fit everyone: ${list}.`;
}

function inspectQuote(index) {
  selectQuote(index);
  $('.stage').scrollIntoView({ behavior: motion.matches ? 'auto' : 'smooth', block: 'center' });
  stageSelect.children[index]?.focus({ preventScroll: true });
}

function quoteStatus(fits) {
  if (fits === undefined) return 'Awaiting responses';
  return fits ? 'Fits everyone' : 'Outside group limits';
}

const viewSwitch = $('.view-switch');
function setComparisonView(view) {
  $('#quotes').hidden = view === 'table';
  $('#comparison-table').hidden = view !== 'table';
  viewSwitch.querySelectorAll('button').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  });
}
viewSwitch.hidden = false;
viewSwitch.querySelectorAll('button').forEach(button => {
  button.onclick = () => setComparisonView(button.dataset.view);
});

function renderComparisonTable(quotes) {
  const table = element('table');
  table.append(element('caption', '', 'All-in quotes and per-traveler shares'));
  const columnHeaders = table.createTHead().insertRow();
  ['Stay', 'Total', 'Max per person', 'Per night¹', 'Group fit'].forEach(label => {
    const cell = element('th', '', label);
    cell.scope = 'col';
    columnHeaders.append(cell);
  });
  const rows = table.createTBody();
  quotes.forEach(quote => {
    const row = rows.insertRow();
    const stay = element('th');
    stay.scope = 'row';
    const inspect = element('button', 'table-stay', quote.name);
    inspect.type = 'button';
    inspect.setAttribute('aria-label', 'Inspect ' + quote.name);
    inspect.onclick = () => inspectQuote(quote.index);
    stay.append(inspect);
    row.append(stay);
    row.insertCell().textContent = money(quote.total);
    const split = perPerson(quote);
    const shareCell = row.insertCell();
    shareCell.append(element('strong', '', money(split.high)));
    if (split.highCount) shareCell.append(element('small', '', splitBreakdown(split)));
    row.insertCell().textContent = perNight(quote);
    const status = element('span', 'badge', quoteStatus(quote.fits));
    if (quote.fits) status.classList.add('table-fit');
    row.insertCell().append(status);
  });
  const scroll = element('div', 'table-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', 'Stay comparison table');
  scroll.append(table);
  $('#comparison-table').replaceChildren(scroll, element('p', 'fine table-note', '¹ Per traveler, based on the higher share when a split is uneven.'));
}

function renderResults(verdict, quotes, count) {
  const detail = $('#result-detail');
  const state = $('#results-nav-state');
  const panel = $('#round-results');
  $('#copy-summary').hidden = !verdict;
  $('#new-round').hidden = Boolean(remote) || !verdict;
  state.textContent = verdict ? 'Ready' : remote?.superseded ? 'Closed' : 'Pending';
  $('#results-nav').dataset.ready = String(Boolean(verdict));
  panel.dataset.state = verdict ? 'ready' : 'pending';
  if (!verdict) {
    const remaining = round.payers - count;
    detail.replaceChildren(element('p', '', remote?.superseded
      ? 'This round closed before everyone responded.'
      : `Waiting for ${remaining} more ${remaining === 1 ? 'response' : 'responses'} before revealing which stays fit everyone.`));
    return;
  }

  const fits = quotes.filter(quote => quote.fits);
  if (!fits.length) {
    const lowest = Math.min(...quotes.map(quote => perPerson(quote).high));
    detail.replaceChildren(
      element('p', 'result-label', 'No stays fit everyone'),
      element('p', '', `For the next comparison, look for an all-in quote under ${money(lowest)} per traveler. A lower price may still be needed.`)
    );
    return;
  }

  const cheapest = fits[0];
  const recommendation = element('div', 'result-recommendation');
  recommendation.append(
    element('p', 'result-label', 'Lowest-priced stay that fits everyone'),
    element('h4', '', cheapest.name),
    element('p', 'result-price', `${price(cheapest)} ${shareLabel(perPerson(cheapest))} · ${money(cheapest.total)} total`)
  );
  const savings = fits.at(-1).total - cheapest.total;
  if (savings > 0) recommendation.append(element('p', 'fine', `${money(savings)} less for the group than the highest-priced stay that fits.`));
  if (cheapest.url && /^https?:\/\//i.test(cheapest.url)) {
    const listing = element('a', 'result-link', 'Check the original listing ↗');
    listing.href = cheapest.url;
    listing.target = '_blank';
    listing.rel = 'noopener noreferrer';
    recommendation.append(listing);
  }
  const label = quotes.length === 1 ? 'This stay fits everyone.' : `${fits.length} of ${quotes.length} stays fit everyone.`;
  detail.replaceChildren(element('p', '', label), recommendation);
}

function render(animate = false) {
  renderStage();
  const verdict = outcome();
  const count = answered();
  $('#decision-title').textContent = round.title;
  const nights = nightCount();
  const where = round.destination ? round.destination + (round.radius ? ' · ' + round.radius + ' mi radius' : '') + ' · ' : '';
  $('.trip').textContent = where + date(round.start) + '–' + date(round.end) + ' · ' + nights + (nights === 1 ? ' night' : ' nights') + ' · ' + round.payers + ' travelers';
  $('.intro .eyebrow').lastChild.textContent = round.demo ? ' Interactive example' : remote ? ' Shared round' : ' Local comparison';
  $('#progress').textContent = count + ' of ' + round.payers + ' responded' + (verdict ? ' · Complete' : '');
  const who = $('#who');
  const whoText = remote && count ? whoAnswered(remote.names || [], count) : '';
  who.hidden = !whoText;
  who.textContent = whoText;
  $('#pips').replaceChildren(...Array.from({ length: round.payers }, (_, i) => element('span', i < count ? 'on' : '')));
  renderPriceTrack(verdict);
  const existing = new Map([...$('#quotes').children].map(card => [Number(card.dataset.index), card.getBoundingClientRect()]));
  const order = round.quotes.map((quote, index) => ({ ...quote, index, fits: verdict?.[index] }));
  order.sort((a, b) => Number(b.fits ?? false) - Number(a.fits ?? false) || a.total - b.total);
  $('#quotes').replaceChildren(...order.map(quote => {
    const card = element('article', quote.fits ? 'quote fit' : 'quote');
    card.dataset.index = quote.index;
    card.setAttribute('aria-current', String(quote.index === activeQuote));
    const heading = element('header');
    heading.append(element('h3', '', quote.name), element('span', 'badge', quoteStatus(quote.fits)));
    const split = perPerson(quote);
    const amount = element('p', 'price', money(split.high));
    amount.append(element('span', '', ' ' + shareLabel(split) + ' · ' + perNight(quote) + '/night'));
    const details = element('div', 'quote-foot');
    details.append(element('span', '', money(quote.total) + ' total'));
    if (split.highCount) details.append(element('span', '', splitBreakdown(split)));
    const mine = knownLimit();
    if (mine !== null) {
      const over = split.high - mine;
      details.append(element('span', over <= 0 ? 'yours' : 'yours over', over <= 0 ? 'Within your limit' : money(over) + ' above your limit'));
    }
    if (quote.checked) details.append(element('span', '', 'Checked ' + new Date(quote.checked).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })));
    if (quote.url && /^https?:\/\//i.test(quote.url)) {
      const link = element('a', '', 'Original listing');
      link.href = quote.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      details.append(link);
    } else details.append(element('span', '', 'Illustrative quote'));
    const inspect = element('button', 'quote-action', 'Inspect ' + quote.name);
    inspect.type = 'button';
    inspect.onclick = () => inspectQuote(quote.index);
    card.append(heading, amount, details, inspect);
    return card;
  }));
  renderComparisonTable(order);
  renderResults(verdict, order, count);
  if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const card of $('#quotes').children) {
      const previous = existing.get(Number(card.dataset.index));
      if (!previous) continue;
      const next = card.getBoundingClientRect();
      card.animate([
        { transform: 'translate(' + (previous.left - next.left) + 'px,' + (previous.top - next.top) + 'px)', opacity: .62 },
        { transform: 'translate(0,0)', opacity: 1 }
      ], { duration: 420, easing: 'cubic-bezier(.2,.75,.25,1)' });
    }
  }
  $('#round-note').textContent = remote?.superseded
    ? 'This round is closed. Its responses and any result are preserved.'
    : verdict
    ? 'Everyone has responded. Open the group results to review the decision.'
    : remote ? (remote.hostKey ? 'Send the invite below. Each traveler answers on their own device.' : 'Answer on this device. The group only sees which stays fit.')
    : round.demo ? 'Three example travelers have already answered. Your limit is the fourth, and it decides which stays fit.' : 'This local preview collects each response on this device.';
  $('#respond').hidden = !canAnswer();
  $('#respond').textContent = answerLabel();
  showInsight();
  const activeHost = remote?.hostKey && !remote.superseded;
  $('#update-quotes').hidden = !activeHost;
  $('#copy-reminder').hidden = !activeHost || count >= round.payers;
  const historyLinks = $('#round-history');
  historyLinks.replaceChildren();
  for (const [id, label] of [[remote?.previous, 'Previous round'], [remote?.successor, 'Updated round']]) {
    if (!id) continue;
    if (historyLinks.childNodes.length) historyLinks.append(' · ');
    historyLinks.append(roundLink(id, label));
  }
  historyLinks.hidden = !historyLinks.childNodes.length;
  const hideReset = remote ? !activeHost || count === 0 : round.demo && !verdict;
  const resetText = remote ? 'Reset responses' : round.demo ? 'Reset example' : 'Return to example';
  $('#reset').hidden = hideReset;
  $('#reset').textContent = resetText;
  const studioReset = $('#studio-reset');
  if (studioReset) {
    studioReset.hidden = hideReset;
    studioReset.textContent = resetText;
  }
  const studioShare = $('#studio-share');
  if (studioShare) studioShare.hidden = !activeHost;
  deleteButton.hidden = !remote?.hostKey;
  if (activeHost) {
    const url = location.origin + location.pathname + '?round=' + encodeURIComponent(remote.id);
    const topRow = element('div', 'invite-head');
    topRow.append(
      element('p', 'invite-label', 'Invite link · each traveler answers privately on their own device.'),
      element('span', 'invite-status', count + ' / ' + round.payers + ' answered')
    );
    const linkRow = element('div', 'invite-bar');
    const link = element('a', 'invite-link', url);
    link.href = url;
    const inlineCopy = element('button', 'outline invite-copy', 'Copy link');
    inlineCopy.id = 'share';
    inlineCopy.type = 'button';
    inlineCopy.onclick = () => copyInviteLink(inlineCopy, 'Copy link');
    linkRow.append(link, inlineCopy);
    invite.replaceChildren(topRow, linkRow);
    invite.hidden = false;
  } else invite.hidden = true;
  renderHosted();
}

function roundLink(id, label) {
  const link = element('a', '', label);
  link.href = '?round=' + encodeURIComponent(id);
  return link;
}

function renderHosted() {
  const hostedRounds = readHosts().filter(item => storedHostKey(item.id) && !item.successor);
  if (hostedRounds.length) {
    hosted.replaceChildren('Your rounds: ');
    hostedRounds.forEach((item, index) => {
      if (index) hosted.append(' · ');
      const progress = item.superseded ? ' (closed)' : item.payers ? ` (${item.count}/${item.payers} answered)` : '';
      hosted.append(roundLink(item.id, (item.title || 'Round') + progress));
    });
    hosted.hidden = false;
  } else hosted.hidden = true;
}

const host = $('#host');
const guest = $('#guest');
const quoteFields = $('#host-quotes');
let draftParent = null;
let draftSource = null;
let draftKey;
const tripFields = ['title', 'payers', 'start', 'end'];
const quoteKeys = ['name', 'total', 'url', 'checked'];
const quoteInput = (field, key) => field.querySelector('[name=quote-' + key + ']');
function addQuote() {
  if (quoteFields.children.length === 3) return;
  const field = document.createElement('fieldset');
  field.innerHTML = '<legend></legend><label>Stay name<input name="quote-name" required maxlength="70"></label><label>Original listing URL<input name="quote-url" type="url" required placeholder="https://"></label><div class="fieldgrid"><label>All-in total (USD)<input name="quote-total" type="number" min="0.01" max="999999" step=".01" required inputmode="decimal"></label><label>Price checked at<input name="quote-checked" type="datetime-local" required></label></div><p class="fine" data-share></p><button type="button" class="outline" data-remove>Remove quote</button>';
  const confirmation = element('label', 'quote-confirmation');
  const confirm = document.createElement('input');
  confirm.type = 'checkbox';
  confirm.name = 'quote-confirm';
  confirmation.append(confirm, ' I rechecked this all-in total');
  confirmation.hidden = !draftParent;
  field.querySelector('[data-share]').before(confirmation);
  field.querySelector('[data-remove]').onclick = () => {
    if (quoteFields.children.length > 1) field.remove();
    updateQuotes();
    saveHostDraft();
  };
  const checked = field.querySelector('[name=quote-checked]');
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  checked.value = now.toISOString().slice(0, 16);
  quoteFields.append(field);
  updateQuotes();
  return field;
}

function updateQuotes() {
  const n = Number(host.querySelector('[name=payers]').value);
  const startVal = host.querySelector('[name=start]').value;
  const endVal = host.querySelector('[name=end]').value;
  const nights = startVal && endVal && endVal > startVal ? nightCount(startVal, endVal) : null;
  const hostSummary = $('#host-summary');
  if (hostSummary) {
    const parts = [];
    if (nights) parts.push(nights + (nights === 1 ? ' night' : ' nights'));
    if (Number.isInteger(n) && n >= 3 && n <= 8) parts.push(n + ' paying travelers');
    hostSummary.textContent = parts.length ? parts.join(' · ') : '';
    hostSummary.hidden = !parts.length;
  }
  [...quoteFields.children].forEach((field, index) => {
    field.querySelector('legend').textContent = 'Quote ' + (index + 1);
    field.querySelector('[data-remove]').hidden = quoteFields.children.length === 1;
    const total = cents(field.querySelector('[name=quote-total]').value);
    const info = total !== null && n >= 3 && n <= 8 && Number.isInteger(n) ? share(total, n) : null;
    const nightly = info && nights ? ' · ' + money(Math.round(info.high / nights)) + '/night' : '';
    field.querySelector('[data-share]').textContent = info ? money(info.high) + ' ' + shareLabel(info) + nightly + (info.highCount ? ' · ' + splitBreakdown(info) : '') : '';
  });
  $('#add').hidden = quoteFields.children.length === 3;
  const fields = [...quoteFields.children];
  const filled = fields.filter(field => !emptyQuote(field));
  fields.forEach((field, index) => {
    const required = filled.length ? !emptyQuote(field) : index === 0;
    quoteKeys.forEach(key => { quoteInput(field, key).required = required; });
    quoteInput(field, 'confirm').required = required && Boolean(draftParent);
  });
  const ready = filled.filter(field => quoteKeys.every(key => quoteInput(field, key).checkValidity()) &&
    /^https?:\/\//i.test(quoteInput(field, 'url').value) &&
    (!draftParent || quoteInput(field, 'confirm').checked)).length;
  $('#quote-review').textContent = `${filled.length} of 3 shortlist slots filled.` +
    (filled.length ? ` ${ready} of ${filled.length} ready. ` : '') +
    (ready < filled.length ? 'Complete the listing, all-in total and price check for each quote.' : '');
  const empty = fields.some(emptyQuote);
  $('#stay-search-results').querySelectorAll('button').forEach(button => {
    const added = fields.some(field => field.querySelector('[name=quote-url]').value === button.dataset.url);
    button.textContent = added ? 'Added' : !empty && fields.length >= 3 ? 'Shortlist full' : 'Add to shortlist';
    button.disabled = added || (!empty && fields.length >= 3);
  });
}

function emptyQuote(field) {
  return ['name', 'total', 'url'].every(key => !field.querySelector('[name=quote-' + key + ']').value.trim());
}

const searchButton = $('#search-stays');
const searchStatus = $('#stay-search-status');
const searchResults = $('#stay-search-results');
const searchCenter = $('#stay-center');
const destinationInput = $('#stay-destination');
const findDestination = $('#find-destination');
const destinationMatches = $('#destination-matches');
const destinationStatus = $('#destination-status');
let staySearchMode;
let searchVersion = 0;
let destinationVersion = 0;
let selectedDestination = null;
let previousDestination = null;
function configureStaySearch(mode) {
  staySearchMode = mode;
  $('#stay-search').hidden = false;
  if (mode !== 'sandbox') {
    $('#stay-center-label').hidden = false;
    findDestination.hidden = false;
    searchButton.textContent = 'Find stays';
    $('#stay-search-attribution').hidden = false;
    $('#stay-search-note').textContent = mode === 'map'
      ? 'Find real mapped lodging near your destination. Check availability and enter the all-in price before saving.'
      : 'Add a state or country to narrow the destination. Verify each all-in price on the original listing before saving.';
  }
}
function resetDestinationChoice() {
  destinationVersion += 1;
  selectedDestination = null;
  previousDestination = null;
  findDestination.disabled = false;
  destinationMatches.replaceChildren();
  destinationMatches.hidden = true;
  destinationStatus.textContent = '';
}
destinationInput.addEventListener('input', resetDestinationChoice);
searchCenter.addEventListener('input', resetDestinationChoice);
findDestination.onclick = async () => {
  const location = destinationInput.value.trim();
  resetDestinationChoice();
  clearStaySearch();
  if (!location) {
    destinationStatus.textContent = 'Enter a destination.';
    destinationInput.focus();
    return;
  }
  const version = destinationVersion;
  findDestination.disabled = true;
  destinationStatus.textContent = 'Finding destinations…';
  try {
    const { locations } = await api('/stays/locations', {
      method: 'POST', body: JSON.stringify({ location }),
    });
    if (version !== destinationVersion) return;
    destinationStatus.textContent = locations.length
      ? 'Choose a destination below.'
      : 'No destinations found. Add a state or country, or enter coordinates.';
    destinationMatches.replaceChildren(...locations.map(match => {
      const button = element('button', 'outline', match.label);
      button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      button.onclick = () => {
        searchCenter.value = '';
        selectedDestination = match;
        destinationMatches.querySelectorAll('button').forEach(option => {
          option.setAttribute('aria-pressed', String(option === button));
        });
        clearStaySearch();
        destinationStatus.textContent = 'Selected: ' + match.label;
        saveHostDraft();
      };
      return button;
    }));
    destinationMatches.hidden = locations.length === 0;
  } catch (error) {
    if (version === destinationVersion) destinationStatus.textContent = error.message;
  } finally {
    if (version === destinationVersion) findDestination.disabled = false;
  }
};
function clearStaySearch() {
  searchVersion += 1;
  searchButton.disabled = false;
  searchStatus.textContent = '';
  searchResults.replaceChildren();
}
host.querySelectorAll('#stay-destination, #stay-radius, #stay-center, [name=start], [name=end], [name=payers]').forEach(input => {
  input.addEventListener('input', clearStaySearch);
});
searchButton.onclick = async () => {
  const location = destinationInput.value.trim();
  if (!location) {
    searchStatus.textContent = 'Enter a destination.';
    $('#stay-destination').focus();
    return;
  }
  const start = host.querySelector('[name=start]').value;
  const end = host.querySelector('[name=end]').value;
  if (staySearchMode !== 'map' && (!start || !end || end <= start)) {
    searchStatus.textContent = 'Choose check-in and check-out dates.';
    return;
  }
  const adults = Number(host.querySelector('[name=payers]').value);
  const radius = Number($('#stay-radius').value);
  const sandbox = staySearchMode === 'sandbox';
  const mapped = staySearchMode === 'map';
  const center = searchCenter.value.trim() || selectedDestination?.center || '';
  if (!sandbox && !center) {
    searchStatus.textContent = 'Choose a destination match or enter coordinates first.';
    findDestination.focus();
    return;
  }
  const version = ++searchVersion;
  searchResults.replaceChildren();
  searchButton.disabled = true;
  searchStatus.textContent = staySearchMode === 'live' ? 'Searching live listings. This can take a few minutes.' : 'Searching for stays…';
  try {
    const { stays, place } = await api('/stays/search', {
      method: 'POST', body: JSON.stringify({ location: selectedDestination?.label || location, start, end, adults, radius, center }),
    });
    if (version !== searchVersion) return;
    const kind = sandbox ? 'sample ' : '';
    searchStatus.textContent = stays.length
      ? `${stays.length} ${kind}${stays.length === 1 ? 'stay' : 'stays'} found near ${place || location}.`
      : `No ${kind}stays found within ${radius} miles of ${place || location}.`;
    searchResults.replaceChildren(...stays.map(stay => {
      const item = element('li');
      const detail = element('div');
      const rate = stay.total === null
        ? (mapped ? 'Check rates and availability' : 'No USD price returned')
        : money(stay.total) + (sandbox ? ' sample total' : ' reported total');
      detail.append(element('strong', '', stay.name), element('small', '', `${rate} · ${stay.distanceMiles} mi`));
      if (!sandbox) {
        const listing = element('a', '', mapped ? 'View on map ↗' : 'Open listing ↗');
        listing.href = stay.url;
        listing.target = '_blank';
        listing.rel = 'noopener noreferrer';
        detail.append(listing);
      }
      const add = element('button', 'outline', 'Add to shortlist');
      add.type = 'button';
      add.dataset.url = stay.url;
      add.onclick = () => {
        let field = [...quoteFields.children].find(emptyQuote);
        if (!field && quoteFields.children.length < 3) {
          addQuote();
          field = quoteFields.lastElementChild;
        }
        if (!field) return;
        field.querySelector('[name=quote-name]').value = stay.name;
        if (sandbox) field.querySelector('[name=quote-total]').value = (stay.total / 100).toFixed(2);
        field.querySelector('[name=quote-url]').value = stay.url;
        field.dataset.tracked = 'true';
        updateQuotes();
        trackRoundEvent('quote_added');
        saveHostDraft();
      };
      item.append(detail, add);
      return item;
    }));
    updateQuotes();
  } catch (error) {
    if (version === searchVersion) searchStatus.textContent = error.message;
  } finally {
    if (version === searchVersion) searchButton.disabled = false;
  }
};

function seedHostDates() {
  const startInput = host.querySelector('[name=start]');
  const endInput = host.querySelector('[name=end]');
  if (startInput.value || endInput.value) return;
  const start = new Date();
  start.setDate(start.getDate() + ((5 - start.getDay() + 7) % 7 || 7));
  const end = new Date(start);
  end.setDate(end.getDate() + 3);
  const iso = value => value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0');
  startInput.value = iso(start);
  endInput.value = iso(end);
}
function saveHostDraft() {
  if (!host.open || !draftKey) return;
  const form = $('#host-form');
  const trip = Object.fromEntries(tripFields.map(key => [key, form.elements.namedItem(key).value]));
  const quotes = [...quoteFields.children].map(field => ({
    ...Object.fromEntries(quoteKeys.map(key => [key, quoteInput(field, key).value])),
    confirmed: quoteInput(field, 'confirm').checked,
    tracked: field.dataset.tracked === 'true',
  }));
  const draft = { trip, quotes, selectedDestination, previousDestination,
    destination: destinationInput.value, center: searchCenter.value, radius: $('#stay-radius').value };
  try { localStorage.setItem(draftKey, JSON.stringify(draft)); }
  catch { $('#draft-note').textContent = 'Draft storage is unavailable in this browser.'; }
}

function clearHostDraft() {
  try { localStorage.removeItem(draftKey); } catch {}
}

function initializeDraft(restore = true) {
  let draft;
  if (restore) {
    try { draft = JSON.parse(localStorage.getItem(draftKey)); } catch {}
  }
  const form = $('#host-form');
  form.reset();
  for (const key of tripFields) {
    if (draft?.trip?.[key] != null || draftSource?.[key] != null) {
      form.elements.namedItem(key).value = draft?.trip?.[key] ?? draftSource[key];
    }
  }
  resetDestinationChoice();
  clearStaySearch();
  selectedDestination = draft?.selectedDestination || null;
  previousDestination = draft ? draft.previousDestination : draftSource?.destination;
  destinationInput.value = draft?.destination ?? previousDestination ?? '';
  searchCenter.value = draft?.center ?? '';
  const destinationLabel = selectedDestination?.label || previousDestination;
  if (destinationLabel) destinationStatus.textContent = 'Selected: ' + destinationLabel;
  const radius = String(draft?.radius || draftSource?.radius || 25);
  const radiusInput = $('#stay-radius');
  if (![...radiusInput.options].some(option => option.value === radius)) {
    radiusInput.add(new Option(radius + ' miles', radius));
  }
  radiusInput.value = radius;
  quoteFields.replaceChildren();
  const startingQuotes = draft?.quotes || (draftParent && draftSource.quotes.map(quote => ({
    name: quote.name, url: quote.url, total: (quote.total / 100).toFixed(2), tracked: true,
  }))) || [{}];
  for (const quote of startingQuotes.slice(0, 3)) {
    const field = addQuote();
    quoteKeys.forEach(key => {
      if (quote[key] != null) quoteInput(field, key).value = quote[key];
    });
    quoteInput(field, 'confirm').checked = Boolean(quote.confirmed);
    if (quote.tracked) field.dataset.tracked = 'true';
  }
  if (!quoteFields.children.length) addQuote();
  $('#host-title').textContent = draftParent ? 'Update quotes' : 'Compare your stays';
  form.querySelector('button[type=submit]').textContent = draftParent ? 'Create updated round'
    : server.shared ? 'Create shared round' : 'Save local comparison';
  $('#host-sharing-note').textContent = draftParent
    ? 'Confirm every all-in total. The updated round starts with zero responses and the current round closes.'
    : server.shared ? 'This round is saved on the server and can be shared with an invite link.'
    : 'This preview saves the round in this browser. Guest sharing requires a server.';
  $('#draft-note').textContent = draft ? 'Restored the draft saved in this browser.' : 'Changes are saved as a draft in this browser.';
  $('#form-error').textContent = '';
  seedHostDates();
  updateQuotes();
}

document.querySelectorAll('[data-open=host]').forEach(button => button.onclick = () => {
  const followUp = button.id === 'update-quotes';
  if (followUp && (!remote?.hostKey || remote.superseded)) return;
  draftParent = followUp ? { id: remote.id, key: remote.hostKey } : null;
  draftSource = followUp || button.id === 'new-round' ? round : null;
  draftKey = 'inbudget-host-draft-v1:' + (draftParent?.id || 'new');
  initializeDraft();
  host.showModal();
});
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());
$('#add').onclick = () => { addQuote(); saveHostDraft(); };
$('#discard-draft').onclick = () => { clearHostDraft(); initializeDraft(false); };
$('#host-form').addEventListener('input', event => {
  const field = event.target.closest('#host-quotes fieldset');
  if (field) {
    const confirmation = quoteInput(field, 'confirm');
    if (quoteKeys.includes(event.target.name.replace('quote-', ''))) confirmation.checked = false;
    if (event.target === confirmation && confirmation.checked) {
      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      quoteInput(field, 'checked').value = now.toISOString().slice(0, 16);
    }
    if (!field.dataset.tracked && quoteInput(field, 'name').value.trim() &&
        /^https?:\/\//i.test(quoteInput(field, 'url').value) && quoteInput(field, 'url').checkValidity()) {
      field.dataset.tracked = 'true';
      trackRoundEvent('quote_added');
    }
  }
  updateQuotes();
  saveHostDraft();
});
$('#host-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const error = $('#form-error');
  const start = data.get('start'), end = data.get('end');
  if (end <= start) { error.textContent = 'Check-out must be after check-in.'; return; }
  const fields = [...quoteFields.children].filter(field => !emptyQuote(field));
  const parent = draftParent;
  const submittedDraft = draftKey;
  if (parent && fields.some(field => !quoteInput(field, 'confirm').checked)) {
    error.textContent = 'Confirm every all-in total before updating the round.';
    return;
  }
  const quotes = fields.map(field => {
    const get = name => field.querySelector('[name=quote-' + name + ']').value;
    return { name: get('name').trim(), total: cents(get('total')), url: get('url'), checked: new Date(get('checked')).toISOString() };
  });
  if (!data.get('title').trim() || !quotes.length || quotes.some(q => !q.name || !q.total || !/^https?:\/\//i.test(q.url))) {
    error.textContent = 'Enter a trip name and complete quotes with HTTP or HTTPS listing links.';
    return;
  }
  if (new Set(quotes.map(quote => new URL(quote.url).href)).size !== quotes.length) {
    error.textContent = 'Use each listing link only once.';
    return;
  }
  error.textContent = '';
  const destination = selectedDestination?.label || previousDestination || (searchCenter.value.trim() && destinationInput.value.trim());
  const payload = { title: data.get('title').trim(), start, end, payers: Number(data.get('payers')), quotes,
    ...(destination ? { destination, radius: Number($('#stay-radius').value) } : {}) };
  const submit = event.currentTarget.querySelector('button[type=submit]');
  const discard = $('#discard-draft');
  const close = host.querySelector('[data-close]');
  if (submit.disabled) return;
  submit.disabled = true;
  discard.disabled = true;
  close.disabled = true;
  let created;
  try {
    if (await serverReady()) {
      const path = parent ? '/rounds/' + encodeURIComponent(parent.id) + '/follow-ups' : '/rounds';
      created = await api(path, { method: 'POST', body: JSON.stringify(payload),
        ...(parent ? { headers: { 'x-host-key': parent.key } } : {}) });
    } else if (server.shared || parent) {
      error.textContent = 'Shared rounds are temporarily unavailable. Your quotes are still here. Try again shortly.';
      return;
    }
  } catch (failure) {
    error.textContent = failure.message;
    return;
  } finally {
    submit.disabled = false;
    discard.disabled = false;
    close.disabled = false;
  }
  activeQuote = 0;
  try { localStorage.removeItem(submittedDraft); } catch {}
  if (created) {
    if (parent) writeHosts(readHosts().map(item => item.id === parent.id
      ? { ...item, superseded: true, successor: created.id } : item));
    applyRemote(created.round, created.hostKey);
    history.replaceState(null, '', '?round=' + encodeURIComponent(created.id));
    host.close();
    render();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('#invite').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    $('#share')?.focus();
    return;
  }
  remote = null;
  privateLimit = null;
  round = { ...payload, responses: [], demo: false };
  const stored = save();
  host.close();
  render();
  if (!stored) $('#round-note').textContent += ' Browser storage is unavailable. Keep this tab open.';
  $('#decision-title').focus();
});

function paintLimit(raw, syncSlider = true) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const limit = text ? cents(text) : null;
  const invalid = Boolean(text) && limit === null;
  const nights = nightCount();
  const slider = $('#limit-slider');
  const nightlyNode = $('#limit-nightly');
  if (slider && syncSlider && limit !== null) {
    const dollars = Math.round(limit / 100);
    slider.value = String(Math.max(Number(slider.min), Math.min(Number(slider.max), dollars)));
  }
  if (nightlyNode) {
    nightlyNode.textContent = limit !== null
      ? '≈ ' + money(Math.round(limit / nights)) + ' / night across ' + nights + (nights === 1 ? ' night' : ' nights')
      : nights + (nights === 1 ? ' night' : ' nights') + ' · slide or tap a stay below';
  }
  const covered = [];
  $('#guest-fits').replaceChildren(...round.quotes.map(quote => {
    const split = perPerson(quote);
    const need = split.high;
    const within = limit !== null && need <= limit;
    if (within) covered.push(quote.name);
    const row = element('button', 'fit-row' + (within ? ' yes' : ''));
    row.type = 'button';
    row.setAttribute('aria-pressed', String(limit !== null && need === limit));
    const state = within ? 'Within your limit' : limit === null ? 'Set this amount' : money(need - limit) + ' short';
    row.append(
      element('span', 'fit-name', quote.name),
      element('span', 'fit-need', money(need) + ' ' + shareLabel(split) + ' · ' + perNight(quote) + '/night'),
      element('span', 'fit-state', state)
    );
    row.onclick = () => {
      const input = $('#limit');
      input.value = (need / 100).toFixed(2);
      input.setCustomValidity('');
      paintLimit(input.value, true);
      input.focus();
    };
    return row;
  }));
  const summary = $('#guest-summary');
  if (invalid) summary.textContent = 'Use a dollar amount with up to two decimal places.';
  else if (limit === null) summary.textContent = 'Choose a stay, slide the bar, or type the most you would pay.';
  else if (covered.length === round.quotes.length) summary.textContent = 'Every stay is within ' + money(limit) + '.';
  else if (!covered.length) summary.textContent = money(limit) + ' is under every share.';
  else summary.textContent = covered.length + ' of ' + round.quotes.length + ' stays are within ' + money(limit) + '.';
}
$('#respond').onclick = () => {
  const revising = canRevise();
  $('#guest .eyebrow').textContent = remote
    ? (revising ? 'Update your answer' : 'Response ' + (answered() + 1) + ' of ' + round.payers)
    : round.demo ? (revising ? 'Change your answer' : 'Example round')
    : 'Local response ' + (answered() + 1) + ' of ' + round.payers;
  $('#guest-form button[type=submit]').textContent = revising ? (round.demo ? 'Update example' : 'Update my answer') : 'Submit final response';
  $('#guest-fine').textContent = remote
    ? 'Your name is visible to the group. Your dollar amount stays on this device. The server receives which stays fit your budget and shares only the group verdict.'
    : 'Your dollar amount stays in this browser. The shortlist shows which stays fit.';
  $('#guest-form').reset();
  $('#name-label').hidden = !remote;
  const slider = $('#limit-slider');
  if (slider) {
    const shares = round.quotes.map(q => perPerson(q).high / 100);
    const lo = Math.max(10, Math.floor(Math.min(...shares) * 0.72));
    const hi = Math.max(lo + 20, Math.ceil(Math.max(...shares) * 1.22));
    slider.min = String(lo);
    slider.max = String(hi);
    slider.value = String(Math.round((lo + hi) / 2));
  }
  const previous = remote ? storedLimit(remote.id) : privateLimit;
  if (previous !== null) $('#limit').value = (previous / 100).toFixed(2);
  if (remote) $('#traveler-name').value = storedName(remote.id);
  paintLimit($('#limit').value, true);
  guest.showModal();
  (remote && !$('#traveler-name').value ? $('#traveler-name') : $('#limit')).focus();
};
$('#guest-form').addEventListener('submit', async event => {
  event.preventDefault();
  const limit = cents($('#limit').value);
  if (limit === null) {
    $('#limit').setCustomValidity('Enter a dollar amount with up to two decimal places.');
    $('#limit').reportValidity();
    return;
  }
  const revising = canRevise();
  if (!revising && answered() >= round.payers) {
    $('#limit').setCustomValidity('This round already has every response.');
    $('#limit').reportValidity();
    return;
  }
  const travelerName = $('#traveler-name').value.trim().replace(/\s+/g, ' ');
  if (travelerName.length > 40) {
    $('#traveler-name').setCustomValidity('Use 40 characters or fewer.');
    $('#traveler-name').reportValidity();
    return;
  }
  const choice = qualify(round.quotes, round.payers, limit);
  if (remote) {
    const { id } = remote;
    const submit = event.currentTarget.querySelector('button[type=submit]');
    submit.disabled = true;
    let payload;
    try {
      payload = await api('/rounds/' + encodeURIComponent(id) + '/responses', {
        method: 'POST',
        body: JSON.stringify({ traveler: travelerToken(id), choices: choice, ...(travelerName ? { name: travelerName } : {}) })
      });
    } catch (error) {
      if (remote?.id !== id) return;
      if (error.status === 404) {
        leaveDeletedRound(id, missingRoundMessage);
        return;
      }
      if (error.status === 409) unmarkAnswered(id);
      $('#limit').setCustomValidity(error.message);
      $('#limit').reportValidity();
      return;
    } finally {
      submit.disabled = false;
    }
    if (remote?.id !== id) return;
    applyRemote(payload.round);
    markAnswered(id);
    storeLimit(id, limit);
    storeName(id, travelerName);
    focusBestFit();
    $('#guest-form').reset();
    guest.close();
    render(true);
    if (outcome()) $('#results-title').focus();
    else $('#respond').focus();
    return;
  }
  if (round.demo && revising) round.responses[round.payers - 1] = choice;
  else round.responses.push(choice);
  if (round.demo) {
    round.you = limit;
    privateLimit = limit;
  }
  focusBestFit();
  const stored = save();
  $('#guest-form').reset();
  guest.close();
  render(true);
  if (!stored) $('#round-note').textContent += ' Browser storage is unavailable. Keep this tab open.';
  if (outcome()) $('#results-title').focus();
  else $('#respond').focus();
});
$('#limit').oninput = event => {
  event.currentTarget.setCustomValidity('');
  paintLimit(event.currentTarget.value, true);
};
if ($('#limit-slider')) {
  $('#limit-slider').oninput = event => {
    const input = $('#limit');
    input.value = Number(event.currentTarget.value).toFixed(2);
    input.setCustomValidity('');
    paintLimit(input.value, false);
  };
}
$('#traveler-name').oninput = event => event.currentTarget.setCustomValidity('');
async function resetCurrentRound(fromHero = false) {
  if (remote) {
    const { id, hostKey } = remote;
    if (!hostKey) return;
    try {
      const payload = await api('/rounds/' + encodeURIComponent(id) + '/responses', { method: 'DELETE', headers: { 'x-host-key': hostKey } });
      if (remote?.id !== id) return;
      applyRemote(payload.round);
      render();
      (fromHero ? $('#studio-respond') : $('#decision-title')).focus({ preventScroll: fromHero });
    } catch (error) {
      if (remote?.id !== id) return;
      if (error.status === 404) leaveDeletedRound(id, missingRoundMessage);
      else $('#round-note').textContent = error.message;
    }
    return;
  }
  round = structuredClone(demo);
  privateLimit = null;
  activeQuote = 0;
  save();
  render();
  (fromHero ? $('#studio-respond') : $('#decision-title')).focus({ preventScroll: fromHero });
}
$('#reset').onclick = () => resetCurrentRound(false);
if ($('#studio-reset')) $('#studio-reset').onclick = () => resetCurrentRound(true);
const scene = $('#scene');
const journey = mountJourney(index => selectQuote(index));
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const stageSelect = $('#quote-select');
let scrollFrame = 0;

function renderStage() {
  activeQuote = Math.min(activeQuote, round.quotes.length - 1);
  const quote = round.quotes[activeQuote];
  const split = perPerson(quote);
  const verdict = outcome();
  const nights = nightCount();
  const status = verdict ? verdict[activeQuote] ? 'Fits everyone' : 'Outside group limits' : 'Awaiting responses';
  const button = $('#studio-respond');
  journey?.set({ active: activeQuote, count: round.quotes.length, verdict, demo: Boolean(round.demo) });
  scene.dataset.active = String(activeQuote);
  scene.dataset.verdict = verdict ? verdict[activeQuote] ? 'fit' : 'outside' : 'pending';
  $('#ticket-index').textContent = String(activeQuote + 1).padStart(2, '0');
  $('#ticket-name').textContent = quote.name.toUpperCase();
  $('#ticket-price').textContent = money(split.high);
  $('.ticket-price > span').textContent = shareLabel(split).toUpperCase();
  $('#scene-count').textContent = answered() + ' / ' + round.payers + ' RESPONDED';
  const stageTrip = $('#stage-trip');
  if (stageTrip) stageTrip.textContent = date(round.start) + '–' + date(round.end) + ' · ' + nights + 'n';
  $('.stage-header > span').lastChild.textContent = round.demo ? ' ASHEVILLE SHORTLIST' : ' ' + round.title.toUpperCase();
  $('#scene-status').textContent = status;
  $('#studio-caption').textContent = quote.name + ' · ' + money(split.high) + ' ' + shareLabel(split) + ' (' + perNight(quote) + '/night).' + (verdict ? (verdict[activeQuote] ? ' Fits everyone.' : ' Outside the tightest budget.') : '');
  labelAction(button, canAnswer() ? answerLabel() : 'View results');
  stageSelect.style.setProperty('--quote-count', String(round.quotes.length));
  stageSelect.replaceChildren(...round.quotes.map((item, index) => {
    const control = element('button', 'plaque');
    control.append(element('span', 'plaque-name', item.name), element('strong', '', price(item)));
    if (verdict) {
      control.dataset.fit = String(verdict[index]);
      control.append(element('span', 'plaque-state', verdict[index] ? 'Fits everyone' : 'Over a budget'));
    }
    control.type = 'button';
    control.setAttribute('aria-pressed', String(index === activeQuote));
    control.onclick = () => selectQuote(index, true);
    return control;
  }));
  const stageDetail = $('#stage-detail');
  if (stageDetail) {
    const chips = [
      element('span', '', perNight(quote) + ' / night'),
      element('span', '', money(quote.total) + ' total'),
    ];
    if (split.highCount) chips.push(element('span', '', splitBreakdown(split)));
    const mine = knownLimit();
    if (mine !== null) {
      const over = split.high - mine;
      chips.push(element('span', over <= 0 ? 'detail-yours' : 'detail-over', over <= 0 ? 'Within your ' + money(mine) : money(over) + ' above your limit'));
    }
    if (quote.checked) {
      chips.push(element('span', '', 'Checked ' + new Date(quote.checked).toLocaleString([], { month: 'short', day: 'numeric' })));
    }
    if (quote.url && /^https?:\/\//i.test(quote.url)) {
      const link = element('a', 'detail-link', 'Original listing ↗');
      link.href = quote.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      chips.push(link);
    } else {
      chips.push(element('span', '', 'Illustrative quote'));
    }
    stageDetail.replaceChildren(...chips);
  }
  const others = round.quotes.filter((_, index) => index !== activeQuote);
  scene.querySelectorAll('.ticket-back,.ticket-mid').forEach((card, index) => {
    card.hidden = !others[index];
    card.querySelector('.ticket-edge span:last-child').textContent = others[index]?.name.toUpperCase() ?? '';
  });
  updateScroll();
}

function selectQuote(index, restore = false) {
  if (index === activeQuote) {
    if (restore) stageSelect.children[index]?.focus({ preventScroll: true });
    return;
  }
  activeQuote = index;
  renderStage();
  document.querySelectorAll('#quotes .quote').forEach(card => card.setAttribute('aria-current', String(Number(card.dataset.index) === index)));
  document.querySelectorAll('#price-track .track-stop').forEach(stop => stop.setAttribute('aria-pressed', String(Number(stop.dataset.index) === index)));
  if (restore) stageSelect.children[index]?.focus({ preventScroll: true });
  if (!journey && !motion.matches) {
    const card = scene.querySelector('.ticket-front');
    card.getAnimations().forEach(animation => animation.cancel());
    card.animate([{ opacity: .55, transform: 'translate(-46%, -42%) rotateZ(3deg)' }, { opacity: 1, transform: getComputedStyle(card).transform }], { duration: 430, easing: 'cubic-bezier(.2,.72,.24,1)' });
  }
}
stageSelect.addEventListener('keydown', event => {
  const count = round.quotes.length;
  if (count < 2) return;
  const focused = [...stageSelect.children].indexOf(document.activeElement);
  const base = focused >= 0 ? focused : activeQuote;
  let next = -1;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (base + 1) % count;
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (base - 1 + count) % count;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = count - 1;
  if (next >= 0) {
    event.preventDefault();
    selectQuote(next, true);
  }
});

function updateScroll() {
  scrollFrame = 0;
  const story = $('#story');
  const room = story.offsetHeight - story.firstElementChild.offsetHeight;
  const progress = motion.matches || room < 1 ? 0 : Math.min(1, Math.max(0, -story.getBoundingClientRect().top / room));
  scene.style.setProperty('--spread', String(progress));
  journey?.setScroll(progress);
  $('#story-stage').textContent = progress > .5 ? '02 / COMPARE THE OPTIONS' : '01 / INSPECT THE QUOTES';
}
function queueScroll() {
  if (!scrollFrame) scrollFrame = requestAnimationFrame(updateScroll);
}
window.addEventListener('scroll', queueScroll, { passive: true });
window.addEventListener('resize', queueScroll, { passive: true });
motion.addEventListener('change', queueScroll);
scene.addEventListener('pointermove', event => {
  if (journey || motion.matches || event.pointerType !== 'mouse') return;
  const box = scene.getBoundingClientRect();
  scene.style.setProperty('--turn-x', (0.5 - (event.clientY - box.top) / box.height) * 18 + 'deg');
  scene.style.setProperty('--turn-y', ((event.clientX - box.left) / box.width - 0.5) * 24 + 'deg');
});
scene.addEventListener('pointerleave', () => {
  scene.style.setProperty('--turn-x', '0deg');
  scene.style.setProperty('--turn-y', '0deg');
});
guest.addEventListener('close', () => { $('#limit').setCustomValidity(''); $('#traveler-name').setCustomValidity(''); });
$('#studio-respond').onclick = () => {
  if (!canAnswer()) {
    $('#results-title').focus();
  } else {
    $('#respond').click();
  }
};
const deleteButton = element('button', 'outline', 'Delete round');
deleteButton.id = 'delete-round';
deleteButton.type = 'button';
deleteButton.hidden = true;
$('#traveler-responses .round-actions').append(deleteButton);

const missingRoundMessage = 'This shared round is no longer available. Showing the example shortlist.';
function leaveDeletedRound(id, message) {
  forgetHost(id);
  forgetAnswer(id);
  try {
    localStorage.removeItem(hostStoreKey(id));
    localStorage.removeItem(travelerStoreKey(id));
  } catch {}
  remote = null;
  round = structuredClone(demo);
  privateLimit = null;
  activeQuote = 0;
  const url = new URL(location.href);
  url.searchParams.delete('round');
  history.replaceState(null, '', url);
  document.querySelector('.footer > span').textContent = 'Frontend preview · rounds stay on this device';
  if (guest.open) guest.close();
  render();
  if (message) $('#round-note').textContent = message;
}

deleteButton.onclick = async () => {
  if (!remote?.hostKey) return;
  if (!confirm('Delete this round and every traveler response? This cannot be undone.')) return;
  deleteButton.disabled = true;
  const { id, hostKey } = remote;
  try {
    await api('/rounds/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'x-host-key': hostKey } });
    if (remote?.id === id) {
      leaveDeletedRound(id, 'Round deleted. Showing the example shortlist.');
      $('#decision-title').focus();
    }
  } catch (error) {
    if (remote?.id !== id) return;
    if (error.status === 404) leaveDeletedRound(id, missingRoundMessage);
    else $('#round-note').textContent = error.message;
  } finally {
    deleteButton.disabled = false;
  }
};
const invite = element('div', 'invite');
invite.id = 'invite';
invite.hidden = true;
$('#traveler-responses').append(invite);
const hosted = element('p', 'fine');
hosted.id = 'hosted';
hosted.hidden = true;
invite.after(hosted);
async function copyInviteLink(btn, restoreLabel = 'Copy invite link') {
  if (!remote) return;
  const url = location.origin + location.pathname + '?round=' + encodeURIComponent(remote.id);
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = 'Link copied ✓';
    trackRoundEvent('invite_copied');
  } catch {
    btn.textContent = 'Select link below';
  }
  setTimeout(() => { btn.textContent = restoreLabel; }, 2400);
}
function trackRoundEvent(event) {
  if (!server.shared) return;
  api('/events', { method: 'POST', body: JSON.stringify({ event }) }).catch(() => {});
}
host.addEventListener('cancel', event => {
  if (host.querySelector('button[type=submit]').disabled) event.preventDefault();
});
$('#copy-reminder').onclick = async event => {
  if (!remote?.hostKey || remote.superseded) return;
  const button = event.currentTarget;
  const remaining = round.payers - answered();
  const url = roundLink(remote.id, '').href;
  const message = `Quick reminder to enter your private stay budget. We're waiting for ${remaining} more ${remaining === 1 ? 'response' : 'responses'}.\n${url}`;
  try { await navigator.clipboard.writeText(message); button.textContent = 'Reminder copied'; }
  catch { button.textContent = 'Copy unavailable'; }
  setTimeout(() => { button.textContent = 'Copy reminder'; }, 2400);
};
if ($('#studio-share')) $('#studio-share').onclick = event => copyInviteLink(event.currentTarget, 'Copy invite link');
if ($('#copy-summary')) {
  $('#copy-summary').onclick = async event => {
    const btn = event.currentTarget;
    const text = buildSummaryText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Summary copied ✓';
    } catch {
      btn.textContent = 'Copy unavailable';
    }
    setTimeout(() => { btn.textContent = 'Copy summary'; }, 2400);
  };
}

let sharedError;
if (sharedId) {
  try { applyRemote(await api('/rounds/' + encodeURIComponent(sharedId))); }
  catch (error) { sharedError = error; }
}
addQuote();
if (sharedError?.status === 404) {
  leaveDeletedRound(sharedId, missingRoundMessage);
} else {
  render();
  if (sharedError) $('#round-note').textContent = sharedError.message + ' Reload to retry the invite.';
}
if (await serverReady() || server.shared) {
  $('#host-sharing-note').textContent = 'This round is saved on the server and can be shared with an invite link.';
  document.querySelector('#host-form button[type=submit]').textContent = 'Create shared round';
}
async function refreshHostedRounds() {
  await Promise.all(readHosts().filter(item => storedHostKey(item.id)).map(async item => {
    try { rememberHost(await api('/rounds/' + encodeURIComponent(item.id))); }
    catch (error) { if (error.status === 404) forgetHost(item.id); }
  }));
  renderHosted();
}
void refreshHostedRounds();
journey?.start();

let refreshing = false;
async function refreshSharedRound() {
  if (!remote || document.hidden || refreshing) return;
  const snapshot = remote;
  refreshing = true;
  try {
    const payload = await api('/rounds/' + encodeURIComponent(snapshot.id));
    if (remote === snapshot && remoteStamp(payload) !== snapshot.stamp) {
      applyRemote(payload);
      if (remote.superseded && guest.open) guest.close();
      render(true);
    }
  } catch (error) {
    if (remote === snapshot && error.status === 404) {
      leaveDeletedRound(snapshot.id, missingRoundMessage);
    }
  } finally {
    refreshing = false;
  }
}

setInterval(refreshSharedRound, 7000);
document.addEventListener('visibilitychange', refreshSharedRound);
