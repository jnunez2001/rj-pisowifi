// ===== TV SERIES CATALOG =====
// Mirrors server/services/onlineMovieCatalog.js exactly - see that file's
// header for the full reasoning (two merged layers, no hardcoded starter
// list, hidden-list instead of hard delete). Kept as a separate file/table
// set rather than teaching onlineMovieCatalog.js about a "kind" flag,
// since a series (seasons/episodes, whole-series pricing) and a movie
// share almost no shape once you're past id/title/tier/price.
const db = require('../config/database');

function getHiddenIds() {
  return new Set(db.prepare('SELECT tmdb_id FROM tv_series_hidden').all().map((r) => r.tmdb_id));
}

function getAll() {
  const hidden = getHiddenIds();
  const pricingRows = db.prepare('SELECT tmdb_id, title, tier, price_pesos, priority, rental_hours FROM tv_series_pricing').all();
  const feedRows = db.prepare('SELECT tmdb_id, title, first_air_date FROM tv_series_feed').all();

  const merged = new Map();
  for (const row of feedRows) {
    if (hidden.has(row.tmdb_id)) continue;
    merged.set(row.tmdb_id, {
      id: row.tmdb_id, title: row.title, tier: 'free', price_pesos: 0,
      first_air_date: row.first_air_date || null, priority: 0, rental_hours: 0,
    });
  }
  for (const row of pricingRows) {
    if (hidden.has(row.tmdb_id)) continue;
    const existing = merged.get(row.tmdb_id);
    merged.set(row.tmdb_id, {
      id: row.tmdb_id,
      title: existing?.title || row.title,
      tier: row.tier,
      price_pesos: row.price_pesos,
      first_air_date: existing?.first_air_date || null,
      priority: row.priority || 0,
      rental_hours: row.rental_hours || 0,
    });
  }

  return [...merged.values()];
}

function getById(id) {
  const numId = Number(id);
  if (getHiddenIds().has(numId)) return null;
  const pricingRow = db.prepare('SELECT title, tier, price_pesos, priority, rental_hours FROM tv_series_pricing WHERE tmdb_id = ?').get(numId);
  if (pricingRow) {
    const feedRow = db.prepare('SELECT title FROM tv_series_feed WHERE tmdb_id = ?').get(numId);
    return {
      id: numId, title: feedRow?.title || pricingRow.title, tier: pricingRow.tier,
      price_pesos: pricingRow.price_pesos, priority: pricingRow.priority || 0, rental_hours: pricingRow.rental_hours || 0,
    };
  }
  const feedRow = db.prepare('SELECT title FROM tv_series_feed WHERE tmdb_id = ?').get(numId);
  if (feedRow) return { id: numId, title: feedRow.title, tier: 'free', price_pesos: 0, priority: 0, rental_hours: 0 };
  return null;
}

function hide(id) {
  const numId = Number(id);
  db.prepare('INSERT OR IGNORE INTO tv_series_hidden (tmdb_id) VALUES (?)').run(numId);
  db.prepare('DELETE FROM tv_series_feed WHERE tmdb_id = ?').run(numId);
  db.prepare('DELETE FROM tv_series_pricing WHERE tmdb_id = ?').run(numId);
}

function hideMany(ids) {
  const run = db.transaction((list) => {
    for (const id of list) hide(id);
  });
  run(ids.map(Number));
}

function unhide(id) {
  db.prepare('DELETE FROM tv_series_hidden WHERE tmdb_id = ?').run(Number(id));
}

module.exports = { getAll, getById, hide, hideMany, unhide };
