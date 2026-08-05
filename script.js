const form = document.querySelector('#board-form');
const setup = document.querySelector('.board-setup');
const traces = document.querySelector('#traces');
const meta = document.querySelector('#board-meta');
const summary = document.querySelector('#listening-summary');
const issue = document.querySelector('#issue');
const visibility = document.querySelector('#board-visibility');
const usernameInput = document.querySelector('#board-username');
const periodInput = document.querySelector('#board-period');
const customRange = document.querySelector('#custom-range');
const rangeStartInput = document.querySelector('#range-start');
const rangeEndInput = document.querySelector('#range-end');
const selectionPreview = document.querySelector('#selection-preview');
const selectionPreviewStatus = document.querySelector('#selection-preview-status');
const selectionPreviewResults = document.querySelector('#selection-preview-results');
const savedUsername = localStorage.getItem('music-footprint:lastfm-username');
const savedPeriod = localStorage.getItem('music-footprint:lastfm-period');
const savedCustomRange = JSON.parse(localStorage.getItem('music-footprint:custom-range') || 'null');
const limitInputs = { tracks: document.querySelector('#limit-songs'), albums: document.querySelector('#limit-albums'), artists: document.querySelector('#limit-artists') };
const savedLimits = JSON.parse(localStorage.getItem('music-footprint:limits') || 'null');
const visibilityInputs = [...document.querySelectorAll('#board-visibility input[data-component]')];
const savedVisibility = JSON.parse(localStorage.getItem('music-footprint:visible-components') || '{}');

if (savedUsername) usernameInput.value = savedUsername;
if (savedPeriod && [...periodInput.options].some((option) => option.value === savedPeriod)) periodInput.value = savedPeriod;
if (savedCustomRange?.start) rangeStartInput.value = savedCustomRange.start;
if (savedCustomRange?.end) rangeEndInput.value = savedCustomRange.end;
if (savedLimits) Object.entries(limitInputs).forEach(([key, input]) => { if (savedLimits[key] !== undefined) input.value = savedLimits[key]; });
visibilityInputs.forEach((input) => { if (typeof savedVisibility[input.dataset.component] === 'boolean') input.checked = savedVisibility[input.dataset.component]; });

const selectedLimits = () => Object.fromEntries(Object.entries(limitInputs).map(([key, input]) => [key, Math.min(20, Math.max(0, Number(input.value) || 0))]));
const rangeSignature = () => periodInput.value === 'custom' ? `custom:${rangeStartInput.value}:${rangeEndInput.value}` : periodInput.value;
const boardCacheKey = (username, period, limits) => `${username}\u0000${period === 'custom' ? rangeSignature() : period}\u0000${limits.tracks}\u0000${limits.albums}\u0000${limits.artists}`;
let previewTimer;
let previewRun = 0;
const selectionPreviewCache = new Map();

let restoredBoard = false;
try {
  const cachedBoard = JSON.parse(localStorage.getItem('music-footprint:board') || 'null');
  const cachedLimits = cachedBoard?.limits || { tracks: 6, albums: 6, artists: 6 };
  const matchingCustomRange = cachedBoard?.period !== 'custom' || cachedBoard?.rangeSignature === rangeSignature();
  if (cachedBoard?.username === usernameInput.value && cachedBoard?.period === periodInput.value && matchingCustomRange && JSON.stringify(cachedLimits) === JSON.stringify(selectedLimits()) && cachedBoard?.html) {
    setup.hidden = true;
    meta.hidden = false;
    visibility.hidden = false;
    visibility.hidden = false;
    issue.textContent = `${cachedBoard.username.toUpperCase()} · ${cachedBoard.period.toUpperCase()}`;
    summary.textContent = cachedBoard.summary || 'Your saved listening board';
    traces.innerHTML = cachedBoard.html;
    traces.dataset.cacheKey = boardCacheKey(cachedBoard.username, cachedBoard.period, cachedLimits);
    restoredBoard = true;
  }
} catch {
  localStorage.removeItem('music-footprint:board');
}


const escapeHtml = (value) => value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const lastfmUrl = (artist, track) => track ? `https://www.last.fm/music/${encodeURIComponent(artist)}/_/${encodeURIComponent(track)}` : `https://www.last.fm/music/${encodeURIComponent(artist)}`;
const periodLabel = (period) => ({ '7day': 'the last week', '1month': 'the last month', '3month': 'the last 3 months', '6month': 'the last 6 months', '12month': 'the last year', ytd: 'year to date', '5year': 'the last 5 years', overall: 'all time' }[period] || period);
const playLabel = (count, period) => `${Number(count).toLocaleString()} ${Number(count) === 1 ? 'scrobble' : 'scrobbles'} ${period === 'overall' ? 'of all time' : `in ${periodLabel(period)}`}`;
const shuffle = (items) => {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
};

function rangeBounds(period) {
  const now = new Date();
  if (period === 'ytd') return { from: Math.floor(new Date(now.getFullYear(), 0, 1).getTime() / 1000) };
  if (period === '5year') return { from: Math.floor(new Date(now.getFullYear() - 5, now.getMonth(), now.getDate()).getTime() / 1000) };
  if (period !== 'custom') return null;
  const toTimestamp = (value, endOfDay = false) => {
    const [year, month, day] = value.split('-').map(Number);
    return Math.floor(new Date(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0).getTime() / 1000);
  };
  if (!rangeStartInput.value || !rangeEndInput.value) throw new Error('Choose both custom range dates.');
  const from = toTimestamp(rangeStartInput.value);
  const to = toTimestamp(rangeEndInput.value, true);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new Error('Choose a valid custom date range.');
  return { from, to };
}

async function topFromRecentHistory(apiRequest, from, limits, to) {
  const trackCounts = new Map();
  const artistCounts = new Map();
  const albumCounts = new Map();
  let page = 1;
  let totalPages = 1;
  do {
    const parameters = { from, page, limit: 200 };
    if (to) parameters.to = to;
    const payload = await apiRequest('user.getrecenttracks', parameters);
    if (payload.error) throw new Error(payload.message || 'Last.fm could not read this listening range.');
    const entries = payload.recenttracks?.track || [];
    entries.filter((entry) => !entry['@attr']?.nowplaying).forEach((entry) => {
      const artist = typeof entry.artist === 'object' ? entry.artist['#text'] || entry.artist.name : entry.artist;
      const album = typeof entry.album === 'object' ? entry.album['#text'] || entry.album.name : entry.album;
      if (!artist || !entry.name) return;
      const trackKey = `${artist}\u0000${entry.name}`;
      trackCounts.set(trackKey, (trackCounts.get(trackKey) || 0) + 1);
      artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
      if (album) {
        const albumKey = `${artist}\u0000${album}`;
        albumCounts.set(albumKey, (albumCounts.get(albumKey) || 0) + 1);
      }
    });
    totalPages = Number(payload.recenttracks?.['@attr']?.totalPages || page);
    page += 1;
  } while (page <= totalPages);
  const rank = (entries, limit, mapper) => [...entries].sort((a, b) => b[1] - a[1]).slice(0, limit).map(mapper);
  return {
    tracks: rank(trackCounts, limits.tracks, ([key, playcount]) => { const [artist, name] = key.split('\u0000'); return { name, playcount, artist: { name } }; }),
    artists: rank(artistCounts, limits.artists, ([name, playcount]) => ({ name, playcount })),
    albums: rank(albumCounts, limits.albums, ([key, playcount]) => { const [artist, name] = key.split('\u0000'); return { name, playcount, artist: { name } }; }),
  };
}

function setSelectorAvailability() {
  const hasUsername = Boolean(usernameInput.value.trim());
  Object.values(limitInputs).forEach((input) => { input.disabled = !hasUsername; });
  selectionPreview.hidden = !hasUsername;
  if (!hasUsername) {
    selectionPreviewStatus.textContent = 'Enter a Last.fm username to preview your board.';
    selectionPreviewResults.innerHTML = '';
  }
}

function dateValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function syncCustomRangeControls() {
  const isCustom = periodInput.value === 'custom';
  customRange.hidden = !isCustom;
  rangeStartInput.disabled = !isCustom;
  rangeEndInput.disabled = !isCustom;
  if (!isCustom) return;
  const today = new Date();
  const todayValue = dateValue(today);
  rangeStartInput.max = todayValue;
  rangeEndInput.max = todayValue;
  if (!rangeEndInput.value) rangeEndInput.value = todayValue;
  if (!rangeStartInput.value) {
    const monthAgo = new Date(today);
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    rangeStartInput.value = dateValue(monthAgo);
  }
}

function selectionPreviewMarkup(title, items, formatter) {
  const entries = items.length ? items.map(formatter).map((item) => `<li>${escapeHtml(item)}</li>`).join('') : '<li>None selected</li>';
  return `<div class="selection-preview-column"><b>${title}</b><ol>${entries}</ol></div>`;
}

function renderSelectionPreview(selection, limits) {
  selectionPreviewStatus.textContent = '';
  selectionPreviewResults.innerHTML = [
    selectionPreviewMarkup('Songs', selection.tracks.slice(0, limits.tracks), (track) => `${track.name} — ${track.artist?.name || track.artist}`),
    selectionPreviewMarkup('Albums', selection.albums.slice(0, limits.albums), (album) => `${album.name} — ${album.artist?.name || album.artist}`),
    selectionPreviewMarkup('Artists', selection.artists.slice(0, limits.artists), (artist) => artist.name),
  ].join('');
}

async function refreshSelectionPreview() {
  const username = usernameInput.value.trim();
  const limits = selectedLimits();
  const period = periodInput.value;
  const run = ++previewRun;
  setSelectorAvailability();
  if (!username) return;
  const cacheKey = `${username.toLowerCase()}\u0000${rangeSignature()}`;
  const cachedSelection = selectionPreviewCache.get(cacheKey);
  if (cachedSelection) return renderSelectionPreview(cachedSelection, limits);
  selectionPreviewStatus.textContent = 'Loading your top 20 songs, albums, and artists…';
  selectionPreviewResults.innerHTML = '';
  const apiRequest = async (method, parameters = {}) => {
    const response = await fetch(`/api/lastfm?${new URLSearchParams({ method, user: username, period, ...parameters })}`);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The Last.fm service is unavailable.');
    const payload = await response.json();
    if (payload.error) throw new Error(payload.message || 'Last.fm could not read this profile.');
    return payload;
  };
  try {
    const bounds = rangeBounds(period);
    let tracks;
    let artists;
    let albums;
    if (bounds) {
      ({ tracks, artists, albums } = await topFromRecentHistory(apiRequest, bounds.from, { tracks: 20, albums: 20, artists: 20 }, bounds.to));
    } else {
      const [trackPayload, artistPayload, albumPayload] = await Promise.all([
        apiRequest('user.gettoptracks', { limit: 20 }),
        apiRequest('user.gettopartists', { limit: 20 }),
        apiRequest('user.gettopalbums', { limit: 20 }),
      ]);
      tracks = trackPayload.toptracks?.track || [];
      artists = artistPayload.topartists?.artist || [];
      albums = albumPayload.topalbums?.album || [];
    }
    if (run !== previewRun) return;
    const selection = { tracks, artists, albums };
    selectionPreviewCache.set(cacheKey, selection);
    renderSelectionPreview(selection, limits);
  } catch (error) {
    if (run !== previewRun) return;
    selectionPreviewStatus.textContent = error.message || 'Could not preview this profile.';
  }
}

function scheduleSelectionPreview() {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(refreshSelectionPreview, 450);
}

const draggableCardSelector = '.wiki-summary,.citation-source,.lastfm-source,.quiz-source,.lrclib-source';
let draggedCard = null;

function componentForCard(card) {
  if (card.classList.contains('wiki-summary')) return 'wiki';
  if (card.classList.contains('citation-source')) return 'citation';
  if (card.classList.contains('quiz-source')) return 'quiz';
  if (card.classList.contains('lrclib-source')) return 'lyrics';
  if (card.classList.contains('lastfm-source')) return card.classList.contains('album') ? 'album' : card.classList.contains('artist') ? 'artist' : 'track';
  return '';
}

function updateDisplayedCardCount() {
  const cardCount = [...traces.querySelectorAll(draggableCardSelector)].filter((card) => !card.hidden).length;
  const baseSummary = summary.textContent.replace(/\s*·\s*\d+\s+cards?\s*$/i, '').trim();
  summary.textContent = `${baseSummary} · ${cardCount} cards`;
}

function applyComponentVisibility() {
  const settings = Object.fromEntries(visibilityInputs.map((input) => [input.dataset.component, input.checked]));
  traces.querySelectorAll(draggableCardSelector).forEach((card) => {
    const component = componentForCard(card);
    card.hidden = component && settings[component] === false;
  });
  updateDisplayedCardCount();
}

function applySavedCardOrder() {
  const cards = [...traces.querySelectorAll(draggableCardSelector)];
  let savedOrder = [];
  try { savedOrder = JSON.parse(localStorage.getItem('music-footprint:card-order') || '[]'); } catch { /* No saved order yet. */ }
  const cardsById = new Map(cards.map((card) => [card.dataset.cardId, card]));
  const ordered = [...savedOrder.map((id) => cardsById.get(id)).filter(Boolean), ...cards.filter((card) => !savedOrder.includes(card.dataset.cardId))];
  ordered.forEach((card) => traces.append(card));
}

function prepareBoardCards() {
  // Boards saved before RYM was removed may still contain its old cards.
  traces.querySelectorAll('.rym-source').forEach((card) => card.remove());
  [...traces.childNodes].forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) node.remove();
  });
  traces.querySelectorAll(draggableCardSelector).forEach((card) => {
    card.draggable = true;
    card.classList.add('draggable-card');
  });
  applyComponentVisibility();
  applySavedCardOrder();
}

function saveCardOrder() {
  const order = [...traces.querySelectorAll(draggableCardSelector)].map((card) => card.dataset.cardId).filter(Boolean);
  localStorage.setItem('music-footprint:card-order', JSON.stringify(order));
}

traces.addEventListener('dragstart', (event) => {
  const card = event.target.closest(draggableCardSelector);
  if (!card) return;
  draggedCard = card;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', card.dataset.cardId || 'card');
  window.requestAnimationFrame(() => card.classList.add('is-dragging'));
});

traces.addEventListener('dragover', (event) => {
  if (!draggedCard) return;
  event.preventDefault();
  const target = event.target.closest(draggableCardSelector);
  if (!target || target === draggedCard) return;
  const bounds = target.getBoundingClientRect();
  const beforeTarget = event.clientY < bounds.top + bounds.height / 2 || (Math.abs(event.clientY - (bounds.top + bounds.height / 2)) < 18 && event.clientX < bounds.left + bounds.width / 2);
  traces.insertBefore(draggedCard, beforeTarget ? target : target.nextSibling);
});

traces.addEventListener('dragend', () => {
  if (!draggedCard) return;
  draggedCard.classList.remove('is-dragging');
  draggedCard = null;
  saveCardOrder();
});

traces.addEventListener('click', (event) => {
  const option = event.target.closest('.quiz-option');
  if (!option || option.disabled) return;
  const quiz = option.closest('.quiz-source');
  const correct = option.dataset.correct === 'true';
  quiz.querySelectorAll('.quiz-option').forEach((button) => {
    button.disabled = true;
    if (button.dataset.correct === 'true') button.classList.add('is-correct');
  });
  if (!correct) option.classList.add('is-incorrect');
  quiz.querySelector('.quiz-feedback').textContent = correct ? 'Correct.' : `The answer is ${quiz.querySelector('.quiz-option.is-correct').textContent}.`;
});

if (restoredBoard) prepareBoardCards();

function musicNameMatches(results, artist) {
  const normalizedArtist = artist.toLowerCase();
  const musicHint = /\b(band|musician|singer|rapper|songwriter|recording artist|music group|duo|artist)\b/i;
  return results.filter((result) => {
    const title = result.title.toLowerCase();
    return (title.startsWith(normalizedArtist) || title.startsWith(`the ${normalizedArtist}`)) && musicHint.test(`${result.title} ${result.snippet}`);
  });
}

function selectMusicResult(results, artist, expectedType = '') {
  const groupHint = /\b(band|music group|rock group|duo|collective)\b/i;
  const nameMatches = musicNameMatches(results, artist);
  if (expectedType === 'Group') return nameMatches.find((result) => groupHint.test(`${result.title} ${result.snippet}`)) || nameMatches.find((result) => /\(band\)|\(group\)/i.test(result.title));
  return nameMatches[0];
}

async function musicIdentity(artist, mbid, bio = '') {
  const cacheKey = `music-footprint:identity:${mbid || artist.toLowerCase()}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached?.type) return cached;
  } catch { /* Re-resolve malformed cached identity data. */ }
  let identity;
  try {
    const response = await fetch(`/api/musicbrainz?${new URLSearchParams(mbid ? { mbid } : { artist })}`);
    if (!response.ok) throw new Error('No MusicBrainz match.');
    const payload = await response.json();
    const candidate = mbid ? payload : (payload.artists || []).find((item) => item.name?.toLowerCase() === artist.toLowerCase() && item.type === 'Group');
    if (candidate?.type) identity = { type: candidate.type, source: 'musicbrainz' };
  } catch { /* Fall back to explicit Last.fm biography language. */ }
  identity ||= { type: /\b(is|are) an? (?:american |british |canadian |english )?(?:indie |rock |pop |electronic |alternative )?(band|group|duo)\b/i.test(bio) ? 'Group' : '', source: 'lastfm' };
  try { localStorage.setItem(cacheKey, JSON.stringify(identity)); } catch { /* Identity caching is an optimization only. */ }
  return identity;
}

async function wikipediaCard(artist, listeningStat, options = {}) {
  const search = new URL('https://en.wikipedia.org/w/api.php');
  search.search = new URLSearchParams({ action: 'query', list: 'search', srsearch: `${artist} band musician music`, srlimit: '8', format: 'json', origin: '*' });
  const searchPayload = await fetch(search).then((response) => response.json());
  const results = searchPayload.query?.search || [];
  const ambiguous = musicNameMatches(results, artist).length > 1;
  let identity = { type: '' };
  if (ambiguous) {
    const bio = options.getBio ? await options.getBio() : '';
    identity = await musicIdentity(artist, options.mbid, bio);
  }
  const result = selectMusicResult(results, artist, identity.type);
  if (!result) throw new Error(`No music-related Wikipedia result for ${artist}.`);
  const title = result.title.replaceAll(' ', '_');
  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const page = await fetch(summaryUrl).then((response) => response.json());
  if (!page.extract) throw new Error(`No Wikipedia summary for ${artist}.`);
  const parse = new URL('https://en.wikipedia.org/w/api.php');
  parse.search = new URLSearchParams({ action: 'parse', page: result.title, prop: 'text', format: 'json', origin: '*' });
  const parsed = await fetch(parse).then((response) => response.json());
  const article = new DOMParser().parseFromString(parsed.parse?.text?.['*'] || '', 'text/html');
  article.querySelectorAll('style, script').forEach((node) => node.remove());
  const paragraphs = [...article.querySelectorAll('p')].filter((paragraph) => paragraph.textContent.trim().length > 70).slice(0, 3);
  const formattedText = paragraphs.map((paragraph) => {
    paragraph.querySelectorAll('sup, style, script').forEach((node) => node.remove());
    paragraph.querySelectorAll('a').forEach((link) => {
      const href = link.getAttribute('href') || '';
      link.setAttribute('href', href.startsWith('/') ? `https://en.wikipedia.org${href}` : href);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noreferrer');
    });
    return paragraph.outerHTML;
  }).join('') || `<p>${escapeHtml(page.extract)}</p>`;
  const imageUrl = page.originalimage?.source || page.thumbnail?.source;
  const image = imageUrl ? `<img class="wiki-image" src="${imageUrl}" alt="" />` : '<div class="wiki-image"></div>';
  const normalizeCitationText = (value) => {
    const text = String(value || '');
    let decoded = text;
    try { decoded = decodeURIComponent(text); } catch { /* Keep the original text when it contains a literal percent sign. */ }
    return decoded.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  };
  const artistTerms = [normalizeCitationText(artist), normalizeCitationText(artist).replace(/^the\s+/, '')].filter((term) => term.length > 2);
  const citationDate = (reference) => {
    const datetime = reference.querySelector('time[datetime]')?.getAttribute('datetime');
    const text = datetime || reference.textContent;
    const matched = String(text || '').match(/\b\d{4}-\d{2}-\d{2}\b|\b(?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,)?\s+\d{4}\b|\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i);
    if (!matched) return '';
    const date = new Date(matched[0].includes('-') ? `${matched[0]}T12:00:00` : matched[0]);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  };
  const citations = [...article.querySelectorAll('ol.references > li')]
    .map((reference) => {
      const link = reference.querySelector('a.external');
      const referenceText = reference.textContent.replace(/\s+/g, ' ').trim();
      const quotedTitle = referenceText.match(/[“"]([^”"]{8,180})[”"]/);
      const title = quotedTitle?.[1]?.trim() || '';
      return link && title && !/\.mw-parser-output|\{\s*[\w-]+\s*:|background(?:-color)?\s*:|url\s*\(/i.test(title) ? { url: link.href, title, referenceText, publishedAt: citationDate(reference) } : null;
    })
    .filter(Boolean)
    .filter((citation) => citation.url.startsWith('http') && citation.title.length > 8)
    .filter((citation) => {
      const referenceText = `${normalizeCitationText(citation.referenceText)} ${normalizeCitationText(citation.url)}`;
      return artistTerms.some((term) => referenceText.includes(term));
    })
    .filter((citation) => !/web\.archive\.(org|com)|archive\.org|archive\.(today|ph|is)|wayback|webcache/i.test(citation.url))
    .filter((citation, index, list) => list.findIndex((item) => item.url === citation.url) === index)
    .slice(0, 3);
  const wikiUrl = page.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(result.title)}`;
  const wiki = `<article class="wiki-summary" data-card-id="wiki-${encodeURIComponent(artist)}"><div class="wiki-header"><span class="personal-stat">${escapeHtml(listeningStat)}</span><img class="wiki-logo" src="https://upload.wikimedia.org/wikipedia/commons/6/63/Wikipedia-logo.png" alt="Wikipedia" /></div><div class="wiki-copy">${image}${formattedText}</div><a class="wiki-open" href="${wikiUrl}" target="_blank" rel="noreferrer" aria-label="Open Wikipedia source">↗</a></article>`;
  const citationCards = await Promise.all(citations.map((citation) => citationCard(citation, listeningStat, artist, wikiUrl)));
  return [wiki, ...citationCards];
}

async function citationCard(citation, listeningStat, artist, wikiUrl) {
  const source = new URL(citation.url).hostname.replace(/^www\./, '');
  const favicon = `https://${source}/favicon.ico`;
  const title = citation.title.replace(/\s+/g, ' ').slice(0, 170);
  let excerpt = '';
  let publishedAt = citation.publishedAt || '';
  try {
    const response = await fetch(`/api/article?${new URLSearchParams({ url: citation.url })}`);
    if (response.ok) {
      const article = await response.json();
      excerpt = article.excerpt || '';
      publishedAt ||= article.publishedAt || '';
    }
  } catch { /* Citation cards remain useful even when an article cannot be read. */ }
  const articleExcerpt = excerpt ? `<small class="citation-excerpt">${escapeHtml(excerpt)}</small>` : '';
  const dateMarkup = publishedAt ? `<time class="citation-date">${escapeHtml(publishedAt)}</time>` : '';
  return `<article class="citation-source" data-card-id="citation-${encodeURIComponent(citation.url)}"><a class="citation-main" href="${citation.url}" target="_blank" rel="noreferrer" aria-label="Open Wikipedia-cited source ${escapeHtml(title)}"></a><small class="personal-stat">${escapeHtml(listeningStat)}</small><div class="citation-label"><span>Wikipedia citation</span><span class="citation-brand"><img src="${favicon}" alt="" onerror="this.style.display='none'" /><b>${escapeHtml(source)}</b></span></div>${dateMarkup}<p>${escapeHtml(title)}</p>${articleExcerpt}<small class="citation-origin">From <a href="${wikiUrl}" target="_blank" rel="noreferrer">${escapeHtml(artist)}</a></small><a class="citation-open" href="${citation.url}" target="_blank" rel="noreferrer" aria-label="Open citation">↗</a></article>`;
}

const fallbackQuizLocations = [
  'Austin, Texas', 'Brooklyn, New York', 'Chicago, Illinois', 'Los Angeles, California',
  'Manchester, England', 'Montreal, Quebec', 'Nashville, Tennessee', 'Portland, Oregon',
  'Seattle, Washington', 'Toronto, Ontario',
];

function cleanLocation(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+in\s+\d{4}.*$/i, '')
    .replace(/(?:,|\s)\s*(?:formed|founded|originated|started|created|led|fronted|composed|produced|released)\b.*$/i, '')
    .replace(/\s+by\s+[A-Z][A-Za-z .'-]*$/i, '')
    .replace(/\s*(?:and|with|which|where|while)\b.*$/i, '')
    .replace(/[;.]$/, '')
    .trim();
}

function locationFactFromBio(text, artist) {
  const body = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const groupHint = /\b(band|group|duo|collective)\b/i.test(body);
  const patterns = groupHint
    ? [
      { type: 'formation', expression: /\b(?:formed|originated|founded|started)\s+(?:in|from)\s+([A-Z][^.;()]{2,90})/i },
      { type: 'formation', expression: /\b(?:band|group|duo|collective)\s+from\s+([A-Z][^.;()]{2,90})/i },
    ]
    : [
      { type: 'hometown', expression: /\bborn(?:\s+[^.]{0,55}?)?\s+in\s+([A-Z][^.;()]{2,90})/i },
      { type: 'hometown', expression: /\b(?:musician|singer|rapper|songwriter|artist)\s+from\s+([A-Z][^.;()]{2,90})/i },
    ];
  for (const candidate of patterns) {
    const match = body.match(candidate.expression);
    const location = cleanLocation(match?.[1]);
    if (location && location.length < 70 && !location.toLowerCase().includes(artist.toLowerCase())) return { location, type: candidate.type };
  }
  return null;
}

async function artistLocationFact(artist, lastfmBio = '') {
  try {
    const search = new URL('https://en.wikipedia.org/w/api.php');
    search.search = new URLSearchParams({ action: 'query', list: 'search', srsearch: `${artist} band musician music`, srlimit: '8', format: 'json', origin: '*' });
    const searchPayload = await fetch(search).then((response) => response.json());
    const result = selectMusicResult(searchPayload.query?.search || [], artist);
    if (result) {
      const summary = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(result.title.replaceAll(' ', '_'))}`).then((response) => response.json());
      const fact = locationFactFromBio(summary.extract, artist);
      if (fact) return { ...fact, source: 'Wikipedia', url: summary.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(result.title)}` };
    }
  } catch { /* Last.fm remains the fallback source. */ }
  const fallbackFact = locationFactFromBio(lastfmBio, artist);
  return fallbackFact ? { ...fallbackFact, source: 'Last.fm', url: lastfmUrl(artist) } : null;
}

function quizQuestion(fact, artist) {
  return fact.type === 'formation' ? `Where did ${artist} form?` : `Where is ${artist} from?`;
}

function artistQuizCard(fact, listeningStat, distractorLocations) {
  const answerKey = fact.location.toLowerCase();
  const uniqueLocations = (locations) => [...new Set(locations.map(cleanLocation).filter((location) => location && location.toLowerCase() !== answerKey))];
  const otherArtistLocations = uniqueLocations(distractorLocations);
  const fallbackLocations = shuffle(uniqueLocations(fallbackQuizLocations).filter((location) => !otherArtistLocations.some((other) => other.toLowerCase() === location.toLowerCase())));
  const choices = [...otherArtistLocations, ...fallbackLocations].slice(0, 3);
  if (choices.length < 3) return '';
  const options = shuffle([fact.location, ...choices]).map((location) => `<button class="quiz-option" type="button" data-correct="${location === fact.location}">${escapeHtml(location)}</button>`).join('');
  return `<article class="quiz-source" data-card-id="quiz-${encodeURIComponent(fact.artist)}"><small class="personal-stat">${escapeHtml(listeningStat)}</small><span class="quiz-kicker">Artist quiz</span><p>${escapeHtml(quizQuestion(fact, fact.artist))}</p><div class="quiz-options">${options}</div><small class="quiz-feedback" aria-live="polite"></small><a class="quiz-source-link" href="${fact.url}" target="_blank" rel="noreferrer">Source: ${escapeHtml(fact.source)} ↗</a></article>`;
}

async function geniusPageUrl(artist, track) {
  const fallback = `https://genius.com/search?q=${encodeURIComponent(`${artist} ${track}`)}`;
  const result = await fetch(`/api/genius?${new URLSearchParams({ q: `${artist} ${track}` })}`).then((response) => response.json());
  const hits = result.response?.sections?.flatMap((section) => section.hits || []) || [];
  const title = track.toLowerCase();
  const artistName = artist.toLowerCase();
  const song = hits.find((hit) => hit.type === 'song' && hit.result?.title?.toLowerCase() === title && hit.result?.primary_artist?.name?.toLowerCase().includes(artistName));
  return song?.result?.url || fallback;
}

async function lrclibCard(artist, track, listeningStat) {
  const response = await fetch(`/api/lrclib?${new URLSearchParams({ artist, track })}`);
  if (response.status === 204) return '';
  const payload = await response.json();
  if (!payload.excerpt) return '';
  const geniusUrl = await geniusPageUrl(artist, track).catch(() => `https://genius.com/search?q=${encodeURIComponent(`${artist} ${track}`)}`);
  return `<a class="lrclib-source" data-card-id="lyrics-${encodeURIComponent(`${artist}-${track}`)}" href="${geniusUrl}" target="_blank" rel="noreferrer" aria-label="Open Genius annotations for ${escapeHtml(track)}"><small class="personal-stat">${escapeHtml(listeningStat)}</small><img class="genius-logo" src="/assets/genius-logo.png" alt="Genius" /><img class="service-logo lrclib-logo" src="https://lrclib.net/favicon.ico" alt="LRCLIB" /><q>${escapeHtml(payload.excerpt)}…</q><span>${escapeHtml(track)} · ${escapeHtml(artist)}<br />Lyrics provided by LRCLIB · annotations on Genius</span><i>↗</i></a>`;
}

function descriptionText(wiki) {
  return (wiki?.content || wiki?.summary || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().replace(/Read more on Last\.fm\.?$/i, '');
}

function artwork(info, fallback = '') {
  const image = info?.image?.find((entry) => entry.size === 'extralarge')?.['#text'] || info?.image?.at(-1)?.['#text'] || fallback;
  return image?.includes('2a96cbd8b46e442fc41c2b86b821562f') ? '' : image;
}

function lastfmTrackFacts(track) {
  const metrics = [];
  if (track?.listeners) metrics.push({ value: Number(track.listeners).toLocaleString(), label: 'listeners across Last.fm' });
  if (track?.playcount) metrics.push({ value: Number(track.playcount).toLocaleString(), label: 'scrobbles across Last.fm' });
  return metrics.map((metric) => `<span class="lastfm-metric"><strong>${metric.value}</strong><small>${metric.label}</small></span>`).join('');
}

function lastfmAlbumFacts(album) {
  const metrics = [];
  if (album?.playcount) metrics.push({ value: Number(album.playcount).toLocaleString(), label: 'scrobbles across Last.fm' });
  const tracks = Array.isArray(album?.tracks?.track) ? album.tracks.track : [];
  const durationValue = tracks.reduce((total, track) => total + Number(track.duration || 0), 0);
  const seconds = durationValue > 10000 ? Math.round(durationValue / 1000) : Math.round(durationValue);
  const length = tracks.length && seconds ? `${tracks.length} tracks, ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '';
  const releaseDate = album?.releasedate?.replace(/\s+/g, ' ').trim() || '';
  const metricMarkup = metrics.map((metric) => `<span class="lastfm-metric"><strong>${metric.value}</strong><small>${metric.label}</small></span>`).join('');
  const detailMarkup = [releaseDate && { label: 'Release Date', value: releaseDate }]
    .filter(Boolean)
    .map((detail) => `<span class="lastfm-detail"><small>${detail.label}</small><strong>${escapeHtml(detail.value)}</strong></span>`).join('');
  return { markup: `${metricMarkup}${detailMarkup}`, length };
}

function lastfmArtistFacts(artist, fallbackArtist = {}) {
  // Last.fm returns this in `stats` for artist.getInfo. Keep the fallback for
  // responses where it is surfaced directly on the top-artist result instead.
  const listeners = artist?.stats?.listeners ?? artist?.listeners ?? fallbackArtist?.stats?.listeners ?? fallbackArtist?.listeners;
  const count = Number(String(listeners ?? '').replace(/,/g, ''));
  if (!Number.isFinite(count) || count < 1) return '';
  return `<span class="lastfm-metric"><strong>${count.toLocaleString()}</strong><small>listeners across Last.fm</small></span>`;
}

function lastfmPageCard(kind, artist, title, stat, imageUrl, description = '', facts = '', titleDetail = '') {
  const pageUrl = kind === 'artist' ? lastfmUrl(artist) : kind === 'album' ? `https://www.last.fm/music/${encodeURIComponent(artist)}/${encodeURIComponent(title)}` : lastfmUrl(artist, title);
  const cover = imageUrl && !['album', 'artist'].includes(kind) && !description ? `<img class="lastfm-art" src="${imageUrl}" alt="" />` : '';
  const hasInlineArtwork = ['album', 'artist'].includes(kind) && imageUrl;
  const titleMarkup = hasInlineArtwork ? `<div class="lastfm-title-row"><img class="${kind}-art" src="${imageUrl}" alt="" /><div class="lastfm-title-copy"><span>${escapeHtml(title)}</span>${kind === 'album' ? `<em>${escapeHtml(artist)}</em>` : ''}${titleDetail ? `<small class="lastfm-title-detail">${escapeHtml(titleDetail)}</small>` : ''}</div></div>` : `<span>${escapeHtml(title)}</span>`;
  const artistMarkup = kind === 'artist' || (kind === 'album' && hasInlineArtwork) ? '' : `<em>${escapeHtml(artist)}</em>`;
  const body = description ? `<p>${escapeHtml(description)}</p>` : '';
  const metrics = facts ? `<div class="lastfm-facts">${facts}</div>` : '';
  return `<a class="lastfm-source ${kind} ${description ? 'has-description' : 'compact'}" data-card-id="lastfm-${kind}-${encodeURIComponent(`${artist}-${title}`)}" href="${pageUrl}" target="_blank" rel="noreferrer" aria-label="Open Last.fm ${kind} page for ${escapeHtml(title)}"><small class="personal-stat">${escapeHtml(stat)}</small><img class="service-logo" src="/assets/lastfm-logo.png" alt="Last.fm" />${cover}<div>${titleMarkup}${artistMarkup}<b>${escapeHtml(kind)} page</b>${body}${metrics}</div><i>↗</i></a>`;
}

function cacheCurrentBoard(username, period, limits) {
  localStorage.setItem('music-footprint:board', JSON.stringify({ username, period, rangeSignature: rangeSignature(), limits, summary: summary.textContent, html: traces.innerHTML }));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = usernameInput.value.trim();
  const period = periodInput.value;
  const limits = selectedLimits();
  const boardKey = boardCacheKey(username, period, limits);
  const hasVisibleCache = traces.dataset.cacheKey === boardKey;
  const button = form.querySelector('button');
  button.disabled = true;
  button.innerHTML = 'Collecting <span>…</span>';
  if (!hasVisibleCache) traces.innerHTML = '<div class="empty-board">Collecting your most-played artists and tracks…</div>';

  try {
    localStorage.setItem('music-footprint:lastfm-username', username);
    localStorage.setItem('music-footprint:lastfm-period', period);
    localStorage.setItem('music-footprint:limits', JSON.stringify(limits));
    localStorage.setItem('music-footprint:custom-range', JSON.stringify({ start: rangeStartInput.value, end: rangeEndInput.value }));
    const apiRequest = async (method, parameters = {}) => {
      const response = await fetch(`/api/lastfm?${new URLSearchParams({ method, user: username, period, ...parameters })}`);
      const type = response.headers.get('content-type') || '';
      if (!type.includes('application/json')) throw new Error('The private Last.fm server is not running. Start the app with “node server.js”, then open http://127.0.0.1:4175.');
      return response.json();
    };
    const bounds = rangeBounds(period);
    let tracks;
    let artists;
    let albums;
    if (bounds) {
      if (!hasVisibleCache) traces.innerHTML = '<div class="empty-board">Reading your listening history for this custom range…</div>';
      ({ tracks, artists, albums } = await topFromRecentHistory(apiRequest, bounds.from, limits, bounds.to));
    } else {
      const [payload, artistPayload, albumPayload] = await Promise.all([
        limits.tracks ? apiRequest('user.gettoptracks', { limit: limits.tracks }) : Promise.resolve({ toptracks: { track: [] } }),
        limits.artists ? apiRequest('user.gettopartists', { limit: limits.artists }) : Promise.resolve({ topartists: { artist: [] } }),
        limits.albums ? apiRequest('user.gettopalbums', { limit: limits.albums }) : Promise.resolve({ topalbums: { album: [] } }),
      ]);
      if (payload.error) throw new Error(payload.message || 'Last.fm did not return listening data.');
      tracks = payload.toptracks?.track || [];
      artists = artistPayload.topartists?.artist || [];
      albums = albumPayload.topalbums?.album || [];
    }
    if (!tracks.length && !artists.length && !albums.length) throw new Error('Choose at least one song, album, or artist option.');

    setup.hidden = true;
    meta.hidden = false;
    issue.textContent = `${username.toUpperCase()} · ${period.toUpperCase()}`;
    summary.textContent = `${tracks.length} top songs · ${albums.length} top albums · ${artists.length} top artists`;
    if (!hasVisibleCache) traces.innerHTML = '<div class="empty-board">Finding artist summaries and lyric sources…</div>';
    const cards = await Promise.all(tracks.flatMap(async (track) => {
      const artist = track.artist.name;
      const title = track.name;
      const trackStat = playLabel(track.playcount, period);
      const trackDetails = await apiRequest('track.getInfo', { artist, track: title }).catch(() => ({}));
      const lrclib = await lrclibCard(artist, title, trackStat).catch(() => '');
      const trackCard = lastfmPageCard('track', artist, title, trackStat, artwork(trackDetails.track, artwork(track, '')), descriptionText(trackDetails.track?.wiki), lastfmTrackFacts(trackDetails.track));
      return [lrclib, trackCard];
    }));
    const artistResults = await Promise.all(artists.map(async (artist) => {
      const artistStat = playLabel(artist.playcount, period);
      let details;
      const getDetails = async () => {
        if (!details) details = await apiRequest('artist.getInfo', artist.mbid ? { mbid: artist.mbid } : { artist: artist.name }).catch(() => ({}));
        return details;
      };
      const wiki = await wikipediaCard(artist.name, artistStat, { mbid: artist.mbid, getBio: async () => {
        const profile = await getDetails();
        return profile.artist?.bio?.content || profile.artist?.bio?.summary || '';
      } }).catch(() => []);
      details = await getDetails();
      const lastfm = lastfmPageCard('artist', artist.name, artist.name, artistStat, artwork(details.artist, artwork(artist, '')), descriptionText(details.artist?.bio), lastfmArtistFacts(details.artist, artist));
      const quizFact = await artistLocationFact(artist.name, details.artist?.bio?.content || details.artist?.bio?.summary || '');
      return { cards: [...wiki, lastfm], quizFact: quizFact ? { ...quizFact, artist: artist.name, listeningStat: artistStat } : null };
    }));
    const albumCards = await Promise.all(albums.map(async (album) => {
      const artist = album.artist?.name || album.artist;
      const albumStat = playLabel(album.playcount, period);
      const details = await apiRequest('album.getInfo', { artist, album: album.name }).catch(() => ({}));
      const albumFacts = lastfmAlbumFacts(details.album);
      return lastfmPageCard('album', artist, album.name, albumStat, artwork(details.album, artwork(album, '')), descriptionText(details.album?.wiki), albumFacts.markup, albumFacts.length);
    }));
    const quizFacts = artistResults.map((result) => result.quizFact).filter(Boolean);
    const quizCards = quizFacts.map((fact) => artistQuizCard(fact, fact.listeningStat, quizFacts.filter((other) => other !== fact).map((other) => other.location))).filter(Boolean);
    const allCards = [...artistResults.flatMap((result) => result.cards), ...quizCards, ...cards.flat(), ...albumCards.flat()].filter(Boolean);
    traces.innerHTML = shuffle(allCards).join('');
    summary.textContent = `${tracks.length} top songs · ${albums.length} top albums · ${artists.length} top artists`;
    prepareBoardCards();
    delete traces.dataset.cacheKey;
    cacheCurrentBoard(username, period, limits);
    meta.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (!hasVisibleCache) traces.innerHTML = `<div class="empty-board error">${escapeHtml(error.message)} Check the username and API key, then try again.</div>`;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Build board <span>→</span>';
  }
});

document.querySelector('#edit-board').addEventListener('click', () => {
  setup.hidden = false;
  meta.hidden = true;
  visibility.hidden = true;
  document.querySelector('#board-username').focus();
  scheduleSelectionPreview();
});

Object.values(limitInputs).forEach((input) => input.addEventListener('change', () => {
  input.value = String(Math.min(20, Math.max(0, Number(input.value) || 0)));
  localStorage.setItem('music-footprint:limits', JSON.stringify(selectedLimits()));
  scheduleSelectionPreview();
}));

usernameInput.addEventListener('input', () => {
  setSelectorAvailability();
  scheduleSelectionPreview();
});

periodInput.addEventListener('change', () => {
  syncCustomRangeControls();
  scheduleSelectionPreview();
});

[rangeStartInput, rangeEndInput].forEach((input) => input.addEventListener('change', () => {
  localStorage.setItem('music-footprint:custom-range', JSON.stringify({ start: rangeStartInput.value, end: rangeEndInput.value }));
  scheduleSelectionPreview();
}));

visibilityInputs.forEach((input) => input.addEventListener('change', () => {
  localStorage.setItem('music-footprint:visible-components', JSON.stringify(Object.fromEntries(visibilityInputs.map((control) => [control.dataset.component, control.checked]))));
  applyComponentVisibility();
}));

if (restoredBoard) window.setTimeout(() => form.requestSubmit(), 0);
syncCustomRangeControls();
setSelectorAvailability();
if (usernameInput.value.trim() && !restoredBoard) scheduleSelectionPreview();
