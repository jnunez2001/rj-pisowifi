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

function getHiddenIds() {
  return new Set(db.prepare('SELECT tmdb_id FROM online_movie_hidden').all().map((r) => r.tmdb_id));
}

function getAll() {
  const hidden = getHiddenIds();
  const pricingRows = db.prepare('SELECT tmdb_id, title, tier, price_pesos FROM online_movie_pricing').all();
  const feedRows = db.prepare('SELECT tmdb_id, title, release_date FROM tmdb_movie_feed').all();

  const merged = new Map();
  for (const row of feedRows) {
    if (hidden.has(row.tmdb_id)) continue;
    merged.set(row.tmdb_id, { id: row.tmdb_id, title: row.title, tier: 'free', price_pesos: 0, release_date: row.release_date || null });
  }
  // Pricing rows are applied last, so an admin override always wins over
  // the synced feed's default 'free', and can also introduce a title that
  // was never synced at all (added directly by TMDb ID or search).
  for (const row of pricingRows) {
    if (hidden.has(row.tmdb_id)) continue;
    const existing = merged.get(row.tmdb_id);
    merged.set(row.tmdb_id, {
      id: row.tmdb_id,
      title: existing?.title || row.title,
      tier: row.tier,
      price_pesos: row.price_pesos,
      release_date: existing?.release_date || null,
    });
  }

  return [...merged.values()];
}

function getById(id) {
  const numId = Number(id);
  if (getHiddenIds().has(numId)) return null;
  const pricingRow = db.prepare('SELECT title, tier, price_pesos FROM online_movie_pricing WHERE tmdb_id = ?').get(numId);
  if (pricingRow) {
    const feedRow = db.prepare('SELECT title FROM tmdb_movie_feed WHERE tmdb_id = ?').get(numId);
    return { id: numId, title: feedRow?.title || pricingRow.title, tier: pricingRow.tier, price_pesos: pricingRow.price_pesos };
  }
  const feedRow = db.prepare('SELECT title FROM tmdb_movie_feed WHERE tmdb_id = ?').get(numId);
  if (feedRow) return { id: numId, title: feedRow.title, tier: 'free', price_pesos: 0 };
  return null;
}

// Admin's "Delete" button on the Price Groups table (public/admin/pages/
// movies.html) - for titles that aren't appropriate for customers. A plain
// DELETE from tmdb_movie_feed/online_movie_pricing wouldn't be enough on
// its own: the next "Sync from TMDb" would just re-add it if it's still
// trending/popular. Recording it in online_movie_hidden is what makes the
// removal stick - checked by both getAll()/getById() above and
// tmdbService.js's syncFeed().
function hide(id) {
  const numId = Number(id);
  db.prepare('INSERT OR IGNORE INTO online_movie_hidden (tmdb_id) VALUES (?)').run(numId);
  db.prepare('DELETE FROM tmdb_movie_feed WHERE tmdb_id = ?').run(numId);
  db.prepare('DELETE FROM online_movie_pricing WHERE tmdb_id = ?').run(numId);
}

// Clears a hidden flag - called whenever an admin deliberately re-adds a
// title by TMDb ID or search (server/routes/admin.js), so "hidden" only
// ever means "an admin removed this and hasn't brought it back," not a
// permanent blacklist that can never be undone through the normal add flow.
function unhide(id) {
  db.prepare('DELETE FROM online_movie_hidden WHERE tmdb_id = ?').run(Number(id));
}

module.exports = { getAll, getById, hide, unhide };
