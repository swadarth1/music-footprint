const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const root = __dirname;
const port = Number(process.env.PORT || 4175);
const lrclibExcerptLineCount = 4;
const envFile = path.join(root, '.env');
const localEnv = fs.existsSync(envFile) ? Object.fromEntries(
  fs.readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const equalsAt = line.indexOf('=');
      return [line.slice(0, equalsAt), line.slice(equalsAt + 1)];
    })
) : {};
const env = { ...localEnv, ...process.env };
const allowedMethods = new Set(['user.gettoptracks', 'user.gettopartists', 'user.gettopalbums', 'user.getrecenttracks', 'track.getInfo', 'album.getInfo', 'artist.getInfo']);
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png' };

function decodeHtml(value) {
  let decoded = String(value || '');
  for (let pass = 0; pass < 3; pass += 1) {
    decoded = decoded.replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ').replace(/&#x([0-9a-f]+);?/gi, (_, code) => String.fromCodePoint(parseInt(code, 16))).replace(/&#(\d+);?/g, (_, code) => String.fromCodePoint(Number(code)));
  }
  return decoded;
}

function extractArticlePreview(html) {
  const meta = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)/i);
  const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1] || html.match(/<title[^>]*>([^<]+)/i)?.[1] || '';
  const main = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || '';
  const cleanFragment = (value) => decodeHtml(value.replace(/<(script|style|nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<\/(p|div|h[1-6]|li|br|blockquote)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  const isBoilerplate = (value) => /(?:\b(?:archive|menu|home)\b.*\b(?:archive|menu|home|reviews|features)\b|\b(?:features?|reviews?)\s+(?:album\s+)?(?:reviews?|features?)\b|what'?s the rumpus|past perfect primitive futures)/i.test(value);
  const paragraphs = [...main.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => cleanFragment(match[1])).filter((paragraph) => paragraph.length > 80 && !isBoilerplate(paragraph));
  const metaExcerpt = decodeHtml(meta?.[1] || '').replace(/\s+/g, ' ').trim();
  const text = paragraphs[0] || (metaExcerpt.length > 80 && !isBoilerplate(metaExcerpt) ? metaExcerpt : '');
  const excerpt = text.length > 80 ? text.slice(0, 360).replace(/\s+\S*$/, '').trim() : '';
  const readableExcerpt = /\.mw-parser-output|\{\s*[\w-]+\s*:|background(?:-color)?\s*:|url\s*\(|&#(?:x[0-9a-f]+|\d+);?/i.test(excerpt) ? '' : excerpt;
  return { title: decodeHtml(title).replace(/\s+/g, ' ').trim(), excerpt: readableExcerpt };
}

function isSafeExternalUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return ['http:', 'https:'].includes(parsed.protocol) && host !== 'localhost' && !host.endsWith('.local') && host !== '::1' && !/^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  } catch { return false; }
}

function fetchArticle(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (!isSafeExternalUrl(url) || redirects > 3) return reject(new Error('Unsafe or unsupported article URL.'));
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const upstreamRequest = client.get(target, { headers: { 'User-Agent': 'MusicFootprint/1.0 (local listening board)', Accept: 'text/html,application/xhtml+xml' } }, (upstream) => {
      if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && upstream.headers.location) return resolve(fetchArticle(new URL(upstream.headers.location, target).toString(), redirects + 1));
      if (upstream.statusCode !== 200) return reject(new Error(`Article returned ${upstream.statusCode}.`));
      if (!String(upstream.headers['content-type'] || '').includes('text/html')) return reject(new Error('Source is not an HTML article.'));
      let body = '';
      upstream.setEncoding('utf8');
      upstream.on('data', (chunk) => {
        body += chunk;
        if (body.length > 800000) upstream.destroy(new Error('Article is too large.'));
      });
      upstream.on('end', () => resolve(extractArticlePreview(body)));
    });
    upstreamRequest.setTimeout(7000, () => upstreamRequest.destroy(new Error('Article request timed out.')));
    upstreamRequest.on('error', reject);
  });
}

function send(response, status, body, type = 'application/json') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/api/lastfm') {
    const method = url.searchParams.get('method');
    const user = url.searchParams.get('user');
    const period = url.searchParams.get('period');
    const artist = url.searchParams.get('artist');
    const track = url.searchParams.get('track');
    const album = url.searchParams.get('album');
    const mbid = url.searchParams.get('mbid');
    const limit = Number(url.searchParams.get('limit') || 6);
    const from = url.searchParams.get('from');
    const page = Number(url.searchParams.get('page') || 1);
    const isTopList = method === 'user.gettoptracks' || method === 'user.gettopartists' || method === 'user.gettopalbums';
    const isInfo = ['track.getInfo', 'album.getInfo', 'artist.getInfo'].includes(method);
    if (!allowedMethods.has(method) || !user || !env.LASTFM_API_KEY || (isTopList && !period) || (isInfo && !artist && !(method === 'artist.getInfo' && mbid)) || (method === 'track.getInfo' && !track) || (method === 'album.getInfo' && !album)) return send(response, 400, JSON.stringify({ error: 6, message: 'Missing or invalid Last.fm request.' }));
    const query = new URLSearchParams({ method, user, format: 'json', api_key: env.LASTFM_API_KEY, autocorrect: '1' });
    if (isTopList) { query.set('period', period); query.set('limit', String(Math.min(20, Math.max(1, Number.isFinite(limit) ? limit : 6)))); }
    if (artist) query.set('artist', artist);
    if (track) query.set('track', track);
    if (album) query.set('album', album);
    if (mbid) query.set('mbid', mbid);
    if (method === 'user.getrecenttracks') {
      if (from) query.set('from', from);
      query.set('page', String(Math.max(1, Number.isFinite(page) ? page : 1)));
      query.set('limit', String(Math.min(200, Math.max(1, Number.isFinite(limit) ? limit : 200))));
    }
    https.get(`https://ws.audioscrobbler.com/2.0/?${query}`, (upstream) => {
      let body = '';
      upstream.on('data', (chunk) => { body += chunk; });
      upstream.on('end', () => send(response, upstream.statusCode || 502, body));
    }).on('error', () => send(response, 502, JSON.stringify({ error: 11, message: 'Unable to reach Last.fm.' })));
    return;
  }
  if (url.pathname === '/api/musicbrainz') {
    const mbid = url.searchParams.get('mbid');
    const artist = url.searchParams.get('artist');
    if (!mbid && !artist) return send(response, 400, JSON.stringify({ message: 'Artist or MBID is required.' }));
    const target = mbid
      ? `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(mbid)}?fmt=json`
      : `https://musicbrainz.org/ws/2/artist?fmt=json&limit=5&query=${encodeURIComponent(`artist:"${artist}" AND type:group`)}`;
    https.get(target, { headers: { Accept: 'application/json', 'User-Agent': 'MusicFootprint/1.0 (local listening board)' } }, (upstream) => {
      let body = '';
      upstream.on('data', (chunk) => { body += chunk; });
      upstream.on('end', () => send(response, upstream.statusCode || 502, body));
    }).on('error', () => send(response, 502, JSON.stringify({ message: 'Unable to reach MusicBrainz.' })));
    return;
  }
  if (url.pathname === '/api/genius') {
    const query = url.searchParams.get('q');
    if (!query || query.length > 300) return send(response, 400, JSON.stringify({ message: 'Invalid Genius query.' }));
    https.get(`https://genius.com/api/search/multi?per_page=5&q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': 'MusicFootprint/1.0' } }, (upstream) => {
      let body = '';
      upstream.on('data', (chunk) => { body += chunk; });
      upstream.on('end', () => send(response, upstream.statusCode || 502, body));
    }).on('error', () => send(response, 502, JSON.stringify({ message: 'Unable to reach Genius.' })));
    return;
  }
  if (url.pathname === '/api/musixmatch') {
    const artist = url.searchParams.get('artist');
    const track = url.searchParams.get('track');
    if (!env.MUSIXMATCH_API_KEY) return send(response, 204, '');
    if (!artist || !track) return send(response, 400, JSON.stringify({ message: 'Artist and track are required.' }));
    const query = new URLSearchParams({ q_artist: artist, q_track: track, apikey: env.MUSIXMATCH_API_KEY });
    https.get(`https://api.musixmatch.com/ws/1.1/matcher.lyrics.get?${query}`, (upstream) => {
      let body = '';
      upstream.on('data', (chunk) => { body += chunk; });
      upstream.on('end', () => send(response, upstream.statusCode || 502, body));
    }).on('error', () => send(response, 502, JSON.stringify({ message: 'Unable to reach Musixmatch.' })));
    return;
  }
  if (url.pathname === '/api/lrclib') {
    const artist = url.searchParams.get('artist');
    const track = url.searchParams.get('track');
    if (!artist || !track) return send(response, 400, JSON.stringify({ message: 'Artist and track are required.' }));
    const query = new URLSearchParams({ artist_name: artist, track_name: track });
    https.get(`https://lrclib.net/api/search?${query}`, { headers: { 'User-Agent': 'MusicFootprint/1.0 (local listening board)' } }, (upstream) => {
      let body = '';
      upstream.on('data', (chunk) => { body += chunk; });
      upstream.on('end', () => {
        try {
          const matches = JSON.parse(body);
          const normalize = (value) => String(value || '').trim().toLowerCase();
          const lyric = matches.find((item) => normalize(item.trackName) === normalize(track) && normalize(item.artistName).includes(normalize(artist))) || matches[0];
          const text = lyric?.plainLyrics || lyric?.syncedLyrics?.replace(/^\[[^\]]+\]\s*/gm, '');
          if (!text) return send(response, 204, '');
          const excerpt = text.split(/\r?\n|<br\s*\/?>/i).map((line) => line.trim()).filter(Boolean).slice(0, lrclibExcerptLineCount).join('\n');
          return send(response, 200, JSON.stringify({ excerpt, id: lyric.id }));
        } catch {
          return send(response, 502, JSON.stringify({ message: 'LRCLIB returned an unreadable response.' }));
        }
      });
    }).on('error', () => send(response, 502, JSON.stringify({ message: 'Unable to reach LRCLIB.' })));
    return;
  }
  if (url.pathname === '/api/article') {
    const articleUrl = url.searchParams.get('url');
    if (!articleUrl || !isSafeExternalUrl(articleUrl)) return send(response, 400, JSON.stringify({ message: 'Invalid article URL.' }));
    fetchArticle(articleUrl).then((article) => send(response, 200, JSON.stringify(article))).catch(() => send(response, 204, ''));
    return;
  }
  const publicFiles = { '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/script.js': 'script.js', '/assets/genius-logo.png': 'assets/genius-logo.png', '/assets/lastfm-logo.png': 'assets/lastfm-logo.png' };
  const filename = publicFiles[url.pathname];
  if (!filename) return send(response, 404, 'Not found', 'text/plain');
  const filePath = path.join(root, filename);
  send(response, 200, fs.readFileSync(filePath), contentTypes[path.extname(filePath)] || 'application/octet-stream');
}).listen(port, '0.0.0.0', () => console.log(`Listening board on port ${port}`));
