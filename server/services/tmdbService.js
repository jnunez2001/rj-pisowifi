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

module.exports = { getCachedPosterUrl, getCachedGenres, warmCache };
