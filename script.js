const form = document.querySelector('#board-form');
const setup = document.querySelector('.board-setup');
const traces = document.querySelector('#traces');
const meta = document.querySelector('#board-meta');
const summary = document.querySelector('#listening-summary');
const issue = document.querySelector('#issue');
const usernameInput = document.querySelector('#board-username');
const periodInput = document.querySelector('#board-period');
const savedUsername = localStorage.getItem('music-footprint:lastfm-username');
const savedPeriod = localStorage.getItem('music-footprint:lastfm-period');
const limitInputs = { tracks: document.querySelector('#limit-songs'), albums: document.querySelector('#limit-albums'), artists: document.querySelector('#limit-artists') };
const savedLimits = JSON.parse(localStorage.getItem('music-footprint:limits') || 'null');

if (savedUsername) usernameInput.value = savedUsername;
if (savedPeriod) periodInput.value = savedPeriod;
if (savedLimits) Object.entries(limitInputs).forEach(([key, input]) => { if (savedLimits[key]) input.value = savedLimits[key]; });

const selectedLimits = () => Object.fromEntries(Object.entries(limitInputs).map(([key, input]) => [key, Number(input.value)]));
const boardCacheKey = (username, period, limits) => `${username}\u0000${period}\u0000${limits.tracks}\u0000${limits.albums}\u0000${limits.artists}`;

let restoredBoard = false;
try {
  const cachedBoard = JSON.parse(localStorage.getItem('music-footprint:board') || 'null');
  const cachedLimits = cachedBoard?.limits || { tracks: 6, albums: 6, artists: 6 };
  if (cachedBoard?.username === usernameInput.value && cachedBoard?.period === periodInput.value && JSON.stringify(cachedLimits) === JSON.stringify(selectedLimits()) && cachedBoard?.html) {
    setup.hidden = true;
    meta.hidden = false;
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
const periodLabel = (period) => ({ '7day': 'the last week', '1month': 'the last month', '12month': 'the last year', overall: 'all time' }[period] || period);
const playLabel = (count, period) => `${Number(count).toLocaleString()} ${Number(count) === 1 ? 'scrobble' : 'scrobbles'} in ${periodLabel(period)}`;
const shuffle = (items) => {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
};

function selectMusicResult(results, artist) {
  const normalizedArtist = artist.toLowerCase();
  const musicHint = /\b(band|musician|singer|rapper|songwriter|recording artist|music group|duo|artist)\b/i;
  const nameMatches = results.filter((result) => {
    const title = result.title.toLowerCase();
    return title.startsWith(normalizedArtist) || title.startsWith(`the ${normalizedArtist}`);
  });
  return nameMatches.find((result) => musicHint.test(`${result.title} ${result.snippet}`)) || nameMatches[0];
}

async function wikipediaCard(artist, listeningStat) {
  const search = new URL('https://en.wikipedia.org/w/api.php');
  search.search = new URLSearchParams({ action: 'query', list: 'search', srsearch: `${artist} band musician music`, srlimit: '8', format: 'json', origin: '*' });
  const searchPayload = await fetch(search).then((response) => response.json());
  const result = selectMusicResult(searchPayload.query?.search || [], artist);
  if (!result) throw new Error(`No music-related Wikipedia result for ${artist}.`);
  const title = result.title.replaceAll(' ', '_');
  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const page = await fetch(summaryUrl).then((response) => response.json());
  if (!page.extract) throw new Error(`No Wikipedia summary for ${artist}.`);
  const parse = new URL('https://en.wikipedia.org/w/api.php');
  parse.search = new URLSearchParams({ action: 'parse', page: result.title, prop: 'text', format: 'json', origin: '*' });
  const parsed = await fetch(parse).then((response) => response.json());
  const article = new DOMParser().parseFromString(parsed.parse?.text?.['*'] || '', 'text/html');
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
  const citations = [...article.querySelectorAll('ol.references a.external')]
    .map((link) => ({ url: link.href, title: link.textContent.trim() }))
    .filter((citation) => citation.url.startsWith('http') && citation.title.length > 8)
    .sort((a, b) => Number(/web\.archive\.org|archive\.org/i.test(b.url)) - Number(/web\.archive\.org|archive\.org/i.test(a.url)))
    .filter((citation, index, list) => list.findIndex((item) => item.url === citation.url) === index)
    .slice(0, 2);
  const wikiUrl = page.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(result.title)}`;
  const wiki = `<article class="wiki-summary"><div class="wiki-header"><span class="personal-stat">${escapeHtml(listeningStat)}</span><img class="wiki-logo" src="https://upload.wikimedia.org/wikipedia/commons/6/63/Wikipedia-logo.png" alt="Wikipedia" /></div><div class="wiki-copy">${image}${formattedText}</div><a class="wiki-open" href="${wikiUrl}" target="_blank" rel="noreferrer" aria-label="Open Wikipedia source">↗</a></article>`;
  return [wiki, ...citations.map((citation) => citationCard(citation, listeningStat, artist, wikiUrl))];
}

function citationCard(citation, listeningStat, artist, wikiUrl) {
  const source = new URL(citation.url).hostname.replace(/^www\./, '');
  const favicon = `https://${source}/favicon.ico`;
  const title = citation.title.replace(/\s+/g, ' ').slice(0, 170);
  return `<article class="citation-source"><a class="citation-main" href="${citation.url}" target="_blank" rel="noreferrer" aria-label="Open Wikipedia-cited source ${escapeHtml(title)}"></a><small class="personal-stat">${escapeHtml(listeningStat)}</small><span class="citation-brand"><img src="${favicon}" alt="" onerror="this.style.display='none'" /><b>${escapeHtml(source)}</b></span><span>Wikipedia citation</span><p>${escapeHtml(title)}</p><small class="citation-origin">From <a href="${wikiUrl}" target="_blank" rel="noreferrer">${escapeHtml(artist)}</a></small><a class="citation-open" href="${citation.url}" target="_blank" rel="noreferrer" aria-label="Open citation">↗</a></article>`;
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
  return `<a class="lrclib-source" href="${geniusUrl}" target="_blank" rel="noreferrer" aria-label="Open Genius annotations for ${escapeHtml(track)}"><small class="personal-stat">${escapeHtml(listeningStat)}</small><img class="genius-logo" src="/assets/genius-logo.png" alt="Genius" /><img class="service-logo lrclib-logo" src="https://lrclib.net/favicon.ico" alt="LRCLIB" /><q>${escapeHtml(payload.excerpt)}…</q><span>${escapeHtml(track)} · ${escapeHtml(artist)}<br />Lyrics provided by LRCLIB · annotations on Genius</span><i>↗</i></a>`;
}

function descriptionText(wiki) {
  return (wiki?.content || wiki?.summary || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().replace(/Read more on Last\.fm\.?$/i, '').slice(0, 380);
}

function artwork(info, fallback = '') {
  const image = info?.image?.find((entry) => entry.size === 'extralarge')?.['#text'] || info?.image?.at(-1)?.['#text'] || fallback;
  return image?.includes('2a96cbd8b46e442fc41c2b86b821562f') ? '' : image;
}

function lastfmTrackFacts(track) {
  const metrics = [];
  if (track?.listeners) metrics.push({ value: Number(track.listeners).toLocaleString(), label: 'listeners' });
  if (track?.playcount) metrics.push({ value: Number(track.playcount).toLocaleString(), label: 'total scrobbles' });
  return metrics.map((metric) => `<span class="lastfm-metric"><strong>${metric.value}</strong><small>${metric.label}</small></span>`).join('');
}

function lastfmPageCard(kind, artist, title, stat, imageUrl, description = '', facts = '') {
  const pageUrl = kind === 'artist' ? lastfmUrl(artist) : kind === 'album' ? `https://www.last.fm/music/${encodeURIComponent(artist)}/${encodeURIComponent(title)}` : lastfmUrl(artist, title);
  const cover = imageUrl ? `<img class="lastfm-art" src="${imageUrl}" alt="" />` : '';
  const body = description ? `<p>${escapeHtml(description)}</p>` : '';
  const metrics = facts ? `<div class="lastfm-facts">${facts}</div>` : '';
  return `<a class="lastfm-source ${kind} ${description ? 'has-description' : 'compact'}" href="${pageUrl}" target="_blank" rel="noreferrer" aria-label="Open Last.fm ${kind} page for ${escapeHtml(title)}"><small class="personal-stat">${escapeHtml(stat)}</small><img class="service-logo" src="/assets/lastfm-logo.png" alt="Last.fm" />${cover}<div><span>${escapeHtml(title)}</span><em>${escapeHtml(artist)}</em><b>${escapeHtml(kind)} page</b>${body}${metrics}</div><i>↗</i></a>`;
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
    const apiRequest = async (method, parameters = {}) => {
      const response = await fetch(`/api/lastfm?${new URLSearchParams({ method, user: username, period, ...parameters })}`);
      const type = response.headers.get('content-type') || '';
      if (!type.includes('application/json')) throw new Error('The private Last.fm server is not running. Start the app with “node server.js”, then open http://127.0.0.1:4175.');
      return response.json();
    };
    const [payload, artistPayload, albumPayload] = await Promise.all([apiRequest('user.gettoptracks', { limit: limits.tracks }), apiRequest('user.gettopartists', { limit: limits.artists }), apiRequest('user.gettopalbums', { limit: limits.albums })]);
    if (payload.error) throw new Error(payload.message || 'Last.fm did not return listening data.');
    const tracks = payload.toptracks?.track || [];
    if (!tracks.length) throw new Error('No listening data was found for this range.');
    const artists = artistPayload.topartists?.artist || [];
    const albums = albumPayload.topalbums?.album || [];

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
    const artistCards = await Promise.all(artists.map(async (artist) => {
      const artistStat = playLabel(artist.playcount, period);
      const wiki = await wikipediaCard(artist.name, artistStat).catch(() => []);
      if (wiki.length) return wiki;
      const details = await apiRequest('artist.getInfo', { artist: artist.name }).catch(() => ({}));
      return lastfmPageCard('artist', artist.name, artist.name, artistStat, artwork(details.artist, artwork(artist, '')), descriptionText(details.artist?.bio));
    }));
    const albumCards = await Promise.all(albums.map(async (album) => {
      const artist = album.artist?.name || album.artist;
      const details = await apiRequest('album.getInfo', { artist, album: album.name }).catch(() => ({}));
      return lastfmPageCard('album', artist, album.name, playLabel(album.playcount, period), artwork(details.album, artwork(album, '')), descriptionText(details.album?.wiki));
    }));
    traces.innerHTML = shuffle([...artistCards.flat(), ...cards.flat(), ...albumCards]).join('');
    delete traces.dataset.cacheKey;
    localStorage.setItem('music-footprint:board', JSON.stringify({
      username,
      period,
      limits,
      summary: summary.textContent,
      html: traces.innerHTML,
    }));
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
  document.querySelector('#board-username').focus();
});

Object.values(limitInputs).forEach((input) => input.addEventListener('change', () => {
  localStorage.setItem('music-footprint:limits', JSON.stringify(selectedLimits()));
  if (setup.hidden) form.requestSubmit();
}));

if (restoredBoard) window.setTimeout(() => form.requestSubmit(), 0);
