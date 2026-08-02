const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const root = __dirname;
const port = Number(process.env.PORT || 4175);
const lrclibExcerptLineCount = 4;
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const equalsAt = line.indexOf('=');
      return [line.slice(0, equalsAt), line.slice(equalsAt + 1)];
    })
);
const allowedMethods = new Set(['user.gettoptracks', 'user.gettopartists', 'user.gettopalbums', 'track.getInfo', 'album.getInfo', 'artist.getInfo']);
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png' };

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
    const limit = Number(url.searchParams.get('limit') || 6);
    const isTopList = method === 'user.gettoptracks' || method === 'user.gettopartists' || method === 'user.gettopalbums';
    const isInfo = ['track.getInfo', 'album.getInfo', 'artist.getInfo'].includes(method);
    if (!allowedMethods.has(method) || !user || !env.LASTFM_API_KEY || (isTopList && !period) || (isInfo && !artist) || (method === 'track.getInfo' && !track) || (method === 'album.getInfo' && !album)) return send(response, 400, JSON.stringify({ error: 6, message: 'Missing or invalid Last.fm request.' }));
    const query = new URLSearchParams({ method, user, format: 'json', api_key: env.LASTFM_API_KEY, autocorrect: '1' });
    if (isTopList) { query.set('period', period); query.set('limit', String(Math.min(10, Math.max(1, Number.isFinite(limit) ? limit : 6)))); }
    if (artist) query.set('artist', artist);
    if (track) query.set('track', track);
    if (album) query.set('album', album);
    https.get(`https://ws.audioscrobbler.com/2.0/?${query}`, (upstream) => {
      let body = '';
      upstream.on('data', (chunk) => { body += chunk; });
      upstream.on('end', () => send(response, upstream.statusCode || 502, body));
    }).on('error', () => send(response, 502, JSON.stringify({ error: 11, message: 'Unable to reach Last.fm.' })));
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
  const publicFiles = { '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/script.js': 'script.js', '/assets/genius-logo.png': 'assets/genius-logo.png', '/assets/lastfm-logo.png': 'assets/lastfm-logo.png' };
  const filename = publicFiles[url.pathname];
  if (!filename) return send(response, 404, 'Not found', 'text/plain');
  const filePath = path.join(root, filename);
  send(response, 200, fs.readFileSync(filePath), contentTypes[path.extname(filePath)] || 'application/octet-stream');
}).listen(port, '127.0.0.1', () => console.log(`Listening board: http://127.0.0.1:${port}`));
