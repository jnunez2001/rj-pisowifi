// ===== TMDb poster lookup (for the online movie catalog's card art) =====
// Purely cosmetic - never used for enforcement, gating, or the embed URL
// itself (server/services/onlineMovieCatalog.js's ids are all that's
// needed for that). This just answers "what does this TMDb id's poster
// look like?", once per id, ever, caching the result in
// tmdb_poster_cache so the box isn't re-querying TMDb on every page load.
//
// Fails soft everywhere (returns null, never throws) - matches this app's
// standing rule for add-ons: a poster that fails to load should never be
// treated as urgent or break the movies page.
const db = require('../config/database');
const { decryptSecret } = require('../utils/secretCrypto');

const BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';
const TIMEOUT_MS = 5000;

function getApiKey() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'tmdb_api_key'").get();
  return row && row.value ? decryptSecret(row.value) : '';
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getCached(tmdbId) {
  return db.prepare('SELECT poster_path, genres FROM tmdb_poster_cache WHERE tmdb_id = ?').get(tmdbId);
}

function setCached(tmdbId, posterPath, genres) {
  db.prepare(`
    INSERT INTO tmdb_poster_cache (tmdb_id, poster_path, genres, fetched_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tmdb_id) DO UPDATE SET poster_path = excluded.poster_path, genres = excluded.genres, fetched_at = excluded.fetched_at
  `).run(tmdbId, posterPath, genres ? JSON.stringify(genres) : null);
}

// Fast, synchronous, no network - this is what the live
// GET /api/portal/online-movies route uses on every request, so a page
// load never waits on TMDb. Returns null (not yet warmed, or TMDb has
// nothing for this id) until warmCache() below has run for that id.
function getCachedPosterUrl(tmdbId) {
  const row = getCached(tmdbId);
  return row && row.poster_path ? `${IMAGE_BASE}${row.poster_path}` : null;
}

// Same idea, for genre names (e.g. ["Action", "Science Fiction"]) - used to
// group the Online tab into Netflix-style category rows. Empty array if
// not cached yet or TMDb had none.
function getCachedGenres(tmdbId) {
  const row = getCached(tmdbId);
  if (!row || !row.genres) return [];
  try {
    return JSON.parse(row.genres);
  } catch (e) {
    return [];
  }
}

async function fetchOne(tmdbId, apiKey) {
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/movie/${tmdbId}?api_key=${apiKey}`);
    if (!res.ok) {
      // 404 = TMDb genuinely has nothing for this id, still worth caching
      // so it's not retried forever; other errors (rate limit, network)
      // are left uncached so a later warm-up can retry.
      if (res.status === 404) setCached(tmdbId, null, null);
      return;
    }
    const data = await res.json();
    const genreNames = Array.isArray(data.genres) ? data.genres.map((g) => g.name) : [];
    setCached(tmdbId, data.poster_path || null, genreNames);
  } catch (e) {
    console.warn(`[TMDb] Poster lookup failed for id ${tmdbId}:`, e.message);
  }
}

// One-time (well, "once per never-yet-cached id") warm-up: fetches
// whichever of the given ids aren't already cached, a handful at a time so
// this doesn't slam TMDb's rate limit or this box's own uplink. Meant to be
// run in the background (see server/app.js's startup call, or trigger it
// manually with `node -e "require('./server/services/tmdbService').warmCache(...)"`)
// - never awaited by a live request.
async function warmCache(tmdbIds) {
  const apiKey = getApiKey();
  if (!apiKey) return { skipped: true, reason: 'no_api_key' };

  const uncached = tmdbIds.filter((id) => !getCached(id));
  const CONCURRENCY = 5;
  for (let i = 0; i < uncached.length; i += CONCURRENCY) {
    const batch = uncached.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((id) => fetchOne(id, apiKey)));
  }
  return { skipped: false, fetched: uncached.length };
}

// Test a key (either a freshly-typed one from the admin form, or whatever's
// already saved) against a cheap, real TMDb call. Throws with a readable
// message on failure - admin.js's route wraps this in try/catch and returns
// { success:false, message } the same way every other "Test Connection"
// button in this app does.
async function testConnection(apiKeyOverride) {
  const apiKey = apiKeyOverride || getApiKey();
  if (!apiKey) throw new Error('No API key to test - paste one first.');
  const res = await fetchWithTimeout(`${BASE_URL}/authentication?api_key=${apiKey}`);
  if (res.status === 401) throw new Error('TMDb rejected this key - check it was copied correctly.');
  if (!res.ok) throw new Error(`TMDb returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error('TMDb did not confirm the key as valid.');
  return true;
}

// Live title search for the admin's "add a movie" search box. Returns a
// small, display-ready shape - never the full TMDb response.
async function searchMovies(query) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No TMDb API key configured yet.');
  const res = await fetchWithTimeout(`${BASE_URL}/search/movie?api_key=${apiKey}&query=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`TMDb search failed (HTTP ${res.status})`);
  const data = await res.json();
  return (data.results || []).slice(0, 20).map((m) => ({
    id: m.id,
    title: m.title,
    year: m.release_date ? m.release_date.slice(0, 4) : null,
    poster_path: m.poster_path || null,
  }));
}

// Looks up a single movie's title/poster by TMDb ID - what powers the
// admin's "Add by TMDb ID" quick-add (paste an id you already know,
// skip the search box entirely). Also warms tmdb_poster_cache for it,
// same as any other lookup in this file.
async function getMovieById(tmdbId) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No TMDb API key configured yet.');
  const res = await fetchWithTimeout(`${BASE_URL}/movie/${tmdbId}?api_key=${apiKey}`);
  if (res.status === 404) throw new Error(`TMDb has no movie with ID ${tmdbId}.`);
  if (!res.ok) throw new Error(`TMDb lookup failed (HTTP ${res.status})`);
  const data = await res.json();
  const genreNames = Array.isArray(data.genres) ? data.genres.map((g) => g.name) : [];
  setCached(data.id, data.poster_path || null, genreNames);
  return { id: data.id, title: data.title, poster_path: data.poster_path || null };
}

let genreMapCache = null;
async function getGenreMap(apiKey) {
  if (genreMapCache) return genreMapCache;
  const res = await fetchWithTimeout(`${BASE_URL}/genre/movie/list?api_key=${apiKey}`);
  if (!res.ok) return {};
  const data = await res.json();
  genreMapCache = Object.fromEntries((data.genres || []).map((g) => [g.id, g.name]));
  return genreMapCache;
}

// Pulls TMDb's own Trending/Popular/Top Rated lists into tmdb_movie_feed -
// this is what lets the catalog grow without anyone hand-typing ids. Each
// list is capped at `pages` pages (20 titles/page) to keep this bounded and
// fast rather than trying to mirror TMDb's entire catalog. Also warms
// tmdb_poster_cache for every id it touches, from the SAME response (list
// endpoints already include poster_path/genre_ids - no extra per-title
// request needed here, unlike warmCache() above which is a per-id detail
// lookup for ids that only exist in the hardcoded starter CATALOG).
const FEED_LISTS = [
  { key: 'trending', path: '/trending/movie/week' },
  { key: 'popular', path: '/movie/popular' },
  { key: 'top_rated', path: '/movie/top_rated' },
];

async function syncFeed(pages = 5) {
  const apiKey = getApiKey();
  if (!apiKey) return { skipped: true, reason: 'no_api_key' };

  const genreMap = await getGenreMap(apiKey);
  const hiddenIds = new Set(db.prepare('SELECT tmdb_id FROM online_movie_hidden').all().map((r) => r.tmdb_id));
  const upsertFeed = db.prepare(`
    INSERT INTO tmdb_movie_feed (tmdb_id, title, poster_path, genres, source, release_date, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tmdb_id) DO UPDATE SET title = excluded.title, poster_path = excluded.poster_path,
      genres = excluded.genres, release_date = excluded.release_date, fetched_at = excluded.fetched_at
  `);

  let total = 0;
  const perList = {};
  for (const { key, path } of FEED_LISTS) {
    let count = 0;
    for (let page = 1; page <= pages; page++) {
      let res;
      try {
        res = await fetchWithTimeout(`${BASE_URL}${path}?api_key=${apiKey}&page=${page}`);
      } catch (e) {
        break;
      }
      if (!res.ok) break;
      const data = await res.json();
      const results = data.results || [];
      if (results.length === 0) break;
      for (const m of results) {
        if (hiddenIds.has(m.id)) continue;
        const genreNames = (m.genre_ids || []).map((id) => genreMap[id]).filter(Boolean);
        upsertFeed.run(m.id, m.title, m.poster_path || null, JSON.stringify(genreNames), key, m.release_date || null);
        setCached(m.id, m.poster_path || null, genreNames);
        count++;
      }
      if (page >= (data.total_pages || 1)) break;
    }
    perList[key] = count;
    total += count;
  }

  // Trending/Popular/Top Rated all skew toward long-standing hits (Top
  // Rated especially - it's dominated by decades-old classics), so a
  // recently-released title can be genuinely popular right now and still
  // never surface in any of those three lists yet. This dedicated pass
  // pulls TMDb's own "best of this year" ordering directly (Discover sorted
  // by popularity, filtered to the current calendar year) so the client's
  // "New Releases" row actually has this year's movies in it, not just
  // whatever's popular overall.
  const currentYear = new Date().getFullYear();
  let newReleaseCount = 0;
  for (let page = 1; page <= pages; page++) {
    let res;
    try {
      res = await fetchWithTimeout(`${BASE_URL}/discover/movie?api_key=${apiKey}&sort_by=popularity.desc&primary_release_year=${currentYear}&page=${page}`);
    } catch (e) {
      break;
    }
    if (!res.ok) break;
    const data = await res.json();
    const results = data.results || [];
    if (results.length === 0) break;
    for (const m of results) {
      if (hiddenIds.has(m.id)) continue;
      const genreNames = (m.genre_ids || []).map((id) => genreMap[id]).filter(Boolean);
      upsertFeed.run(m.id, m.title, m.poster_path || null, JSON.stringify(genreNames), 'new_release', m.release_date || null);
      setCached(m.id, m.poster_path || null, genreNames);
      newReleaseCount++;
    }
    if (page >= (data.total_pages || 1)) break;
  }
  perList.new_release = newReleaseCount;
  total += newReleaseCount;

  return { skipped: false, total, perList };
}

function getFeedStatus() {
  const row = db.prepare('SELECT COUNT(*) as count, MAX(fetched_at) as last_synced FROM tmdb_movie_feed').get();
  return { count: row?.count || 0, last_synced: row?.last_synced || null };
}

module.exports = { getCachedPosterUrl, getCachedGenres, warmCache, testConnection, searchMovies, getMovieById, syncFeed, getFeedStatus };
