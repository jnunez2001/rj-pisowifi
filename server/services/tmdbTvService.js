// ===== TMDb TV lookups (TV Shows tab - series/anime/K-drama) =====
// Mirrors server/services/tmdbService.js exactly, but against TMDb's
// separate /tv/* API surface - kept as its own file rather than branching
// tmdbService.js internally, since a "movie" and a "series" share almost
// no data shape (seasons/episodes have no movie equivalent) and mixing
// them into one file's functions would mean an id-type flag threaded
// through nearly every call. Same TMDb API key works for both (one
// account, two API surfaces), see settings.tmdb_api_key.
//
// Fails soft everywhere (returns null/[], never throws from a read path) -
// same standing rule as tmdbService.js: a poster or episode list that
// fails to load should never be treated as urgent or break the page.
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
  return db.prepare('SELECT poster_path, genres, origin_country FROM tv_poster_cache WHERE tmdb_id = ?').get(tmdbId);
}

function setCached(tmdbId, posterPath, genres, originCountry) {
  db.prepare(`
    INSERT INTO tv_poster_cache (tmdb_id, poster_path, genres, origin_country, fetched_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tmdb_id) DO UPDATE SET poster_path = excluded.poster_path, genres = excluded.genres,
      origin_country = excluded.origin_country, fetched_at = excluded.fetched_at
  `).run(tmdbId, posterPath, genres ? JSON.stringify(genres) : null, originCountry ? JSON.stringify(originCountry) : null);
}

function getCachedPosterUrl(tmdbId) {
  const row = getCached(tmdbId);
  return row && row.poster_path ? `${IMAGE_BASE}${row.poster_path}` : null;
}

function getCachedGenres(tmdbId) {
  const row = getCached(tmdbId);
  if (!row || !row.genres) return [];
  try {
    return JSON.parse(row.genres);
  } catch (e) {
    return [];
  }
}

function getCachedOriginCountry(tmdbId) {
  const row = getCached(tmdbId);
  if (!row || !row.origin_country) return [];
  try {
    return JSON.parse(row.origin_country);
  } catch (e) {
    return [];
  }
}

async function fetchOne(tmdbId, apiKey) {
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/tv/${tmdbId}?api_key=${apiKey}`);
    if (!res.ok) {
      if (res.status === 404) setCached(tmdbId, null, null, null);
      return;
    }
    const data = await res.json();
    const genreNames = Array.isArray(data.genres) ? data.genres.map((g) => g.name) : [];
    setCached(tmdbId, data.poster_path || null, genreNames, data.origin_country || []);
  } catch (e) {
    console.warn(`[TMDb TV] Poster lookup failed for id ${tmdbId}:`, e.message);
  }
}

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

// Live title search for the admin's "add a series" search box.
async function searchSeries(query) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No TMDb API key configured yet.');
  const res = await fetchWithTimeout(`${BASE_URL}/search/tv?api_key=${apiKey}&query=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`TMDb search failed (HTTP ${res.status})`);
  const data = await res.json();
  return (data.results || []).slice(0, 20).map((s) => ({
    id: s.id,
    title: s.name,
    year: s.first_air_date ? s.first_air_date.slice(0, 4) : null,
    poster_path: s.poster_path || null,
  }));
}

// Full series detail - title/poster/genres/origin AND season list, so the
// admin's "Add by TMDb ID" and the customer's season picker both work off
// one lookup shape. Also warms tv_poster_cache.
async function getSeriesById(tmdbId) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No TMDb API key configured yet.');
  const res = await fetchWithTimeout(`${BASE_URL}/tv/${tmdbId}?api_key=${apiKey}`);
  if (res.status === 404) throw new Error(`TMDb has no TV series with ID ${tmdbId}.`);
  if (!res.ok) throw new Error(`TMDb lookup failed (HTTP ${res.status})`);
  const data = await res.json();
  const genreNames = Array.isArray(data.genres) ? data.genres.map((g) => g.name) : [];
  setCached(data.id, data.poster_path || null, genreNames, data.origin_country || []);
  const seasons = (data.seasons || [])
    .filter((s) => s.season_number > 0) // TMDb's season 0 is "Specials" - excluded, not what a customer expects when picking a season
    .map((s) => ({
      season_number: s.season_number,
      name: s.name,
      episode_count: s.episode_count,
      poster_path: s.poster_path || null,
    }));
  return { id: data.id, title: data.name, poster_path: data.poster_path || null, overview: data.overview || '', seasons };
}

// Episode list for one season - cached in tv_season_cache for a day (see
// database.js's comment on that table) so repeat browsing of a popular
// series/season doesn't mean a fresh TMDb call every time.
const SEASON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
async function getEpisodes(tmdbId, seasonNumber) {
  const cached = db.prepare('SELECT data, fetched_at FROM tv_season_cache WHERE series_id = ? AND season_number = ?').get(tmdbId, seasonNumber);
  if (cached && Date.now() - new Date(cached.fetched_at.replace(' ', 'T') + 'Z').getTime() < SEASON_CACHE_TTL_MS) {
    try {
      return JSON.parse(cached.data);
    } catch (e) {
      // fall through and re-fetch
    }
  }

  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No TMDb API key configured yet.');
  const res = await fetchWithTimeout(`${BASE_URL}/tv/${tmdbId}/season/${seasonNumber}?api_key=${apiKey}`);
  if (!res.ok) throw new Error(`TMDb season lookup failed (HTTP ${res.status})`);
  const data = await res.json();
  const episodes = (data.episodes || []).map((e) => ({
    episode_number: e.episode_number,
    name: e.name,
    still_path: e.still_path || null,
    air_date: e.air_date || null,
    overview: e.overview || '',
  }));
  db.prepare(`
    INSERT INTO tv_season_cache (series_id, season_number, data, fetched_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(series_id, season_number) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at
  `).run(tmdbId, seasonNumber, JSON.stringify(episodes));
  return episodes;
}

let genreMapCache = null;
async function getGenreMap(apiKey) {
  if (genreMapCache) return genreMapCache;
  const res = await fetchWithTimeout(`${BASE_URL}/genre/tv/list?api_key=${apiKey}`);
  if (!res.ok) return {};
  const data = await res.json();
  genreMapCache = Object.fromEntries((data.genres || []).map((g) => [g.id, g.name]));
  return genreMapCache;
}

// Same three-list + "new this year" shape as tmdbService.js's syncFeed(),
// against TV's endpoints instead. origin_country comes back on list
// responses same as genre_ids, no extra per-title request needed.
const FEED_LISTS = [
  { key: 'trending', path: '/trending/tv/week' },
  { key: 'popular', path: '/tv/popular' },
  { key: 'top_rated', path: '/tv/top_rated' },
];

async function syncFeed(pages = 5) {
  const apiKey = getApiKey();
  if (!apiKey) return { skipped: true, reason: 'no_api_key' };

  const genreMap = await getGenreMap(apiKey);
  const hiddenIds = new Set(db.prepare('SELECT tmdb_id FROM tv_series_hidden').all().map((r) => r.tmdb_id));
  const upsertFeed = db.prepare(`
    INSERT INTO tv_series_feed (tmdb_id, title, poster_path, genres, origin_country, source, first_air_date, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tmdb_id) DO UPDATE SET title = excluded.title, poster_path = excluded.poster_path,
      genres = excluded.genres, origin_country = excluded.origin_country,
      first_air_date = excluded.first_air_date, fetched_at = excluded.fetched_at
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
      for (const s of results) {
        if (hiddenIds.has(s.id)) continue;
        const genreNames = (s.genre_ids || []).map((id) => genreMap[id]).filter(Boolean);
        const originCountry = s.origin_country || [];
        upsertFeed.run(s.id, s.name, s.poster_path || null, JSON.stringify(genreNames), JSON.stringify(originCountry), key, s.first_air_date || null);
        setCached(s.id, s.poster_path || null, genreNames, originCountry);
        count++;
      }
      if (page >= (data.total_pages || 1)) break;
    }
    perList[key] = count;
    total += count;
  }

  // Same reasoning as tmdbService.js's own new-release pass: Trending/
  // Popular/Top Rated skew toward long-running hits, so a brand-new
  // series can be genuinely popular right now and still not surface yet.
  const currentYear = new Date().getFullYear();
  let newReleaseCount = 0;
  for (let page = 1; page <= pages; page++) {
    let res;
    try {
      res = await fetchWithTimeout(`${BASE_URL}/discover/tv?api_key=${apiKey}&sort_by=popularity.desc&first_air_date_year=${currentYear}&page=${page}`);
    } catch (e) {
      break;
    }
    if (!res.ok) break;
    const data = await res.json();
    const results = data.results || [];
    if (results.length === 0) break;
    for (const s of results) {
      if (hiddenIds.has(s.id)) continue;
      const genreNames = (s.genre_ids || []).map((id) => genreMap[id]).filter(Boolean);
      const originCountry = s.origin_country || [];
      upsertFeed.run(s.id, s.name, s.poster_path || null, JSON.stringify(genreNames), JSON.stringify(originCountry), 'new_release', s.first_air_date || null);
      setCached(s.id, s.poster_path || null, genreNames, originCountry);
      newReleaseCount++;
    }
    if (page >= (data.total_pages || 1)) break;
  }
  perList.new_release = newReleaseCount;
  total += newReleaseCount;

  return { skipped: false, total, perList };
}

function getFeedStatus() {
  const row = db.prepare('SELECT COUNT(*) as count, MAX(fetched_at) as last_synced FROM tv_series_feed').get();
  return { count: row?.count || 0, last_synced: row?.last_synced || null };
}

// Mirrors tmdbService.js's getTrendingIds() - see its comment for why this
// isn't just read off tv_series_feed's `source` column.
let trendingCache = { ids: [], fetchedAt: 0 };
const TRENDING_CACHE_MS = 60 * 60 * 1000;

async function getTrendingIds() {
  const apiKey = getApiKey();
  if (!apiKey) return [];
  if (trendingCache.ids.length && Date.now() - trendingCache.fetchedAt < TRENDING_CACHE_MS) {
    return trendingCache.ids;
  }
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/trending/tv/day?api_key=${apiKey}`);
    if (!res.ok) return trendingCache.ids;
    const data = await res.json();
    const ids = (data.results || []).map((s) => s.id);
    trendingCache = { ids, fetchedAt: Date.now() };
    return ids;
  } catch (e) {
    return trendingCache.ids;
  }
}

module.exports = {
  getCachedPosterUrl, getCachedGenres, getCachedOriginCountry, warmCache,
  searchSeries, getSeriesById, getEpisodes, syncFeed, getFeedStatus, getTrendingIds,
};
