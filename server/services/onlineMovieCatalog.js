// ===== ONLINE MOVIE CATALOG =====
// Server-side source of truth for what shows up in the Online Movies tab
// and at what price - kept separate from server/services/movieService.js
// (the LOCAL file-based catalog) on purpose, so nothing here ever touches
// that pipeline. The client's public/portal/assets/js/movies-online.js does
// NOT duplicate this data - it fetches the catalog live from
// GET /api/portal/online-movies, so this file is the single source of
// truth for both display and enforcement.
//
// Two layers, merged in getAll()/getById() below - no hardcoded starter
// list (removed per owner request: nothing should ship in code that isn't
// visible/editable in the admin panel):
//   1. tmdb_movie_feed - auto-populated from TMDb's own Trending/Popular/
//      Top Rated lists (admin panel's Movies > Online > "Sync from TMDB"),
//      see tmdbService.js's syncFeed().
//   2. online_movie_pricing - admin-set tier/price, and how a title gets
//      added directly by TMDb ID or search even if it was never in the
//      synced feed. A title with no row here is free by default.
const db = require('../config/database');

function getAll() {
  const pricingRows = db.prepare('SELECT tmdb_id, title, tier, price_pesos FROM online_movie_pricing').all();
  const feedRows = db.prepare('SELECT tmdb_id, title FROM tmdb_movie_feed').all();

  const merged = new Map();
  for (const row of feedRows) {
    merged.set(row.tmdb_id, { id: row.tmdb_id, title: row.title, tier: 'free', price_pesos: 0 });
  }
  // Pricing rows are applied last, so an admin override always wins over
  // the synced feed's default 'free', and can also introduce a title that
  // was never synced at all (added directly by TMDb ID or search).
  for (const row of pricingRows) {
    const existing = merged.get(row.tmdb_id);
    merged.set(row.tmdb_id, {
      id: row.tmdb_id,
      title: existing?.title || row.title,
      tier: row.tier,
      price_pesos: row.price_pesos,
    });
  }

  return [...merged.values()];
}

function getById(id) {
  const numId = Number(id);
  const pricingRow = db.prepare('SELECT title, tier, price_pesos FROM online_movie_pricing WHERE tmdb_id = ?').get(numId);
  if (pricingRow) {
    const feedRow = db.prepare('SELECT title FROM tmdb_movie_feed WHERE tmdb_id = ?').get(numId);
    return { id: numId, title: feedRow?.title || pricingRow.title, tier: pricingRow.tier, price_pesos: pricingRow.price_pesos };
  }
  const feedRow = db.prepare('SELECT title FROM tmdb_movie_feed WHERE tmdb_id = ?').get(numId);
  if (feedRow) return { id: numId, title: feedRow.title, tier: 'free', price_pesos: 0 };
  return null;
}

module.exports = { getAll, getById };
