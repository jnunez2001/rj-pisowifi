// ===== ONLINE MOVIES =====
// Purely additive: does not touch loadMovies/renderMoviesGrid/openMovie/
// startPlayback/showRentConfirmStep/etc. above (movies.js), the local
// movie_rentals coin flow, or any existing server route. This talks to its
// own server endpoints (GET /api/portal/online-movies,
// GET /api/portal/online-movies/:id/embed) and its own coin mode
// ('online_movie' in server/routes/coin.js), backed by its own
// online_movie_rentals table - see server/services/onlineMovieCatalog.js
// for the actual, ENFORCED tier/price list (admin-managed, Movies > Online
// in the admin panel). Every price shown here (₱${movie.price_pesos}) comes
// straight from the server response, never hardcoded client-side.
//
// Reuses the SAME rent-confirm overlay DOM (movieRentOverlay/
// movieRentTitle/movieRentDesc/movieRentConfirmBtn) that movies.js already
// drives for local premium rentals - safe because movies.js already
// reassigns movieRentConfirmBtn.onclick fresh each time it opens that
// overlay, so whichever flow (local or online) opened it last owns the
// click handler until the overlay closes again.

let onlineAllMovies = [];
let onlineCurrentMac = '';
let onlinePendingRentMovieId = null;
let onlineMoviesRendered = false;

// Kept working (unused while the source toggle is hidden - see
// movies.html) so Local can come back later with a one-line change.
async function setMoviesSource(source) {
  document.querySelectorAll('.movies-source-btn').forEach((b) => b.classList.toggle('active', b.dataset.source === source));
  document.getElementById('localMoviesSection').style.display = source === 'local' ? '' : 'none';
  document.getElementById('onlineMoviesSection').style.display = source === 'online' ? '' : 'none';
  if (source === 'online' && !onlineMoviesRendered) await loadOnlineMovies();
}

const TIER_ROWS = [
  { tier: 'free', label: 'Free' },
  { tier: 'paid', label: 'Paid' },
];

// Takes onlineCurrentMac as already set by the unified init at the bottom
// of this file - see the comment on movies.js's loadMovies() for why this
// doesn't also detect here (a second near-simultaneous /detect call would
// just hit the server's per-IP rate limit and come back blank anyway).
async function loadOnlineMovies() {
  try {
    const res = await fetch(`/api/portal/online-movies?mac=${encodeURIComponent(onlineCurrentMac)}`);
    const data = await res.json();
    onlineAllMovies = data.movies || [];
    onlineMoviesRendered = true;
  } catch (e) {
    onlineAllMovies = [];
  }
}

// Tags each item with which backend/player it came from - never shown to
// the customer, purely internal so movieCardHtml/openMovie-vs-openOnlineMovie
// dispatch knows which system a given card belongs to once both catalogs
// are merged into one set of rows below.
function tagKind(list, kind) {
  list.forEach((m) => { m._kind = kind; });
}

// One shared card renderer for both catalogs, per owner request: the
// customer should see one unified Movies experience, not a "Local" tab and
// an "Online" tab - see the HD library row further down for the local
// (self-hosted, no-ads) titles this also has to render. tier value differs
// between the two ('premium' for local, see movies.js/movieService.js, vs
// 'paid' for online, see onlineMovieCatalog.js) because they were built as
// separate systems before this merge; normalized here rather than changing
// either database schema.
function movieCardHtml(m) {
  const isLocal = m._kind === 'local';
  const isPaidTier = isLocal ? m.tier === 'premium' : m.tier === 'paid';
  const lock = (isPaidTier && !m.unlocked) ? '<div class="movie-card-lock"><i class="fas fa-lock"></i></div>' : '';
  const priceTag = (isPaidTier && !m.unlocked) ? `<div class="movie-card-price">₱${m.price_pesos}</div>` : '';
  const thumbStyle = isLocal && m.thumbnail_path ? ` style="background-image:url('${m.thumbnail_path}')"` : '';
  const posterInner = isLocal
    ? (m.thumbnail_path ? '' : '<i class="fas fa-film" style="font-size:24px;"></i>')
    : (m.poster ? `<img src="${m.poster}" alt="${escapeHtmlMovies(m.title)}" loading="lazy" />` : '<i class="fas fa-film" style="font-size:24px;"></i>');
  const onclick = isLocal ? `openMovie(${m.id})` : `openOnlineMovie(${m.id})`;
  return `
    <div class="movie-card" onclick="${onclick}">
      <div class="movie-card-thumb"${thumbStyle}>${posterInner}</div>
      ${lock}${priceTag}
      <div class="movie-card-title">${escapeHtmlMovies(m.title)}</div>
    </div>
  `;
}

// Groups by TMDb genre (server/services/tmdbService.js's warm-up caches
// these from the same call already fetching posters, no extra requests) -
// this is what gives the Netflix-like "many short shelves stacked down the
// page" structure instead of one giant sideways row per tier. A movie with
// several genres appears in each of those rows, same as real Netflix.
// Rows with fewer than MIN_ROW_SIZE titles are skipped so a single stray
// genre doesn't get its own near-empty shelf.
const MIN_ROW_SIZE = 4;

function buildGenreRows(list) {
  const buckets = new Map();
  list.forEach((m) => {
    (m.genres && m.genres.length ? m.genres : []).forEach((genre) => {
      if (!buckets.has(genre)) buckets.set(genre, []);
      buckets.get(genre).push(m);
    });
  });
  return [...buckets.entries()]
    .filter(([, items]) => items.length >= MIN_ROW_SIZE)
    .sort((a, b) => b[1].length - a[1].length);
}

function rowsHtml(rows) {
  return rows.map(([label, items]) => `
    <div class="movies-online-row">
      <h3 class="movies-online-row-title">${escapeHtmlMovies(label)}</h3>
      <div class="movies-online-row-track">${items.map(movieCardHtml).join('')}</div>
    </div>
  `).join('');
}

// Real usage ranking (server/routes/portal.js increments `views` once per
// actual unlocked play, in GET /online-movies/:id/embed - not on page view,
// so just browsing the grid doesn't inflate it). Hidden entirely until at
// least one movie has a real play, so a fresh install never shows a fake or
// empty "Top 10".
function topWatchedRowHtml(list) {
  const ranked = list.filter((m) => m.views > 0).sort((a, b) => b.views - a.views).slice(0, 10);
  if (ranked.length === 0) return '';
  const cards = ranked.map((m, i) => {
    const card = movieCardHtml(m);
    return card.replace('<div class="movie-card-thumb">', `<div class="movie-card-rank">${i + 1}</div><div class="movie-card-thumb">`);
  }).join('');
  return `
    <div class="movies-online-row movies-online-row-top10">
      <h3 class="movies-online-row-title">🔥 Top 10 Most Watched</h3>
      <div class="movies-online-row-track">${cards}</div>
    </div>
  `;
}

// Sorted by actual release date, newest first - not by TMDb popularity/
// rating like Top Rated is, which is why Top Rated alone skews toward
// decades-old classics and never surfaces this year's titles. Limited to
// the current and previous calendar year so this row doesn't just fill up
// with "recent-ish" older movies once this year's list is thin. Server-side
// filters this out of the sync entirely if release_date is missing (older
// installs that haven't re-synced since this field was added), so this only
// ever needs to check for its presence.
function newReleasesRowHtml(list) {
  const currentYear = new Date().getFullYear();
  const ranked = list
    .filter((m) => m.release_date && parseInt(m.release_date.slice(0, 4), 10) >= currentYear - 1)
    .sort((a, b) => b.release_date.localeCompare(a.release_date))
    .slice(0, 20);
  if (ranked.length === 0) return '';
  return `
    <div class="movies-online-row">
      <h3 class="movies-online-row-title">🆕 New in ${currentYear}</h3>
      <div class="movies-online-row-track">${ranked.map(movieCardHtml).join('')}</div>
    </div>
  `;
}

// The local, self-hosted library (movies.js's allMovies - transcoded files
// this box already has on disk) has no TMDb genre/release-date metadata to
// group by, so it gets one dedicated shelf instead of being sorted into the
// genre rows below. Labeled by what makes it different for the customer (no
// ads, since it's not a third-party embed) rather than by which internal
// system it came from - see the owner's request that drove this merge.
function localLibraryRowHtml(list) {
  if (!list || list.length === 0) return '';
  return `
    <div class="movies-online-row">
      <h3 class="movies-online-row-title">🎬 HD Movies (No Ads)</h3>
      <div class="movies-online-row-track">${list.map(movieCardHtml).join('')}</div>
    </div>
  `;
}

// Genre rows are the default view; falls back to the old tier-based
// grouping only while genres haven't finished warming yet (e.g. right after
// a fresh install, before tmdbService's background fetch completes) so the
// page still has SOME organization instead of nothing. Reads onlineAllMovies
// and allMovies (movies.js) directly rather than taking a list argument, so
// every caller (initial load, search-clear) redraws the exact same merged
// view without needing to remember to pass both catalogs each time.
function renderOnlineMoviesRows() {
  const el = document.getElementById('onlineMoviesRows');
  const top10 = topWatchedRowHtml(onlineAllMovies);
  const newReleases = newReleasesRowHtml(onlineAllMovies);
  const localRow = localLibraryRowHtml(allMovies);
  const genreRows = buildGenreRows(onlineAllMovies);
  if (genreRows.length > 0) {
    el.innerHTML = top10 + newReleases + localRow + rowsHtml(genreRows);
    return;
  }
  const tierRows = TIER_ROWS
    .map(({ tier, label }) => [label, onlineAllMovies.filter((m) => m.tier === tier)])
    .filter(([, items]) => items.length > 0);
  el.innerHTML = top10 + newReleases + localRow + rowsHtml(tierRows);
}

// Flat grid used only for search results, where tier grouping isn't useful.
function renderOnlineMoviesFlat(list) {
  const el = document.getElementById('onlineMoviesRows');
  el.innerHTML = `<div class="movies-grid">${list.map(movieCardHtml).join('')}</div>`;
}

// Owner's call: no coin/session gate right now, opens whether or not the
// device has paid time - the real access control is the network-level
// firewall (nftables), which already blocks an unpaid device from
// reaching vidrock.ru at all. The rent-confirm/coin-insert functions below
// (showOnlineRentConfirmStep etc.) are left in place, just unused, for
// whenever paid mode gets re-planned and wired back in on purpose.
function openOnlineMovie(id) {
  const movie = onlineAllMovies.find((m) => m.id === id);
  if (!movie) return;

  if (movie.tier === 'paid' && !movie.unlocked) {
    onlinePendingRentMovieId = id;
    showOnlineRentConfirmStep(movie);
    return;
  }

  startOnlinePlayback(movie);
}

function showOnlineRentConfirmStep(movie) {
  document.getElementById('movieRentTitle').textContent = movie.title;
  document.getElementById('movieRentDesc').textContent =
    `Insert ₱${movie.price_pesos} in coins to unlock this movie. This is a separate payment from your WiFi time.`;
  document.getElementById('movieRentConfirmBtn').textContent = `Insert ₱${movie.price_pesos} to unlock`;
  document.getElementById('movieRentConfirmBtn').onclick = beginOnlineMovieCoinInsertion;
  document.getElementById('movieRentOverlay').classList.add('show');
}

let onlineMovieCoinPollInterval = null;

async function beginOnlineMovieCoinInsertion() {
  const movie = onlineAllMovies.find((m) => m.id === onlinePendingRentMovieId);
  if (!movie) return;

  // Bug found live: onlineCurrentMac was only ever detected once, when the
  // Movies tab first loaded (loadOnlineMovies() above) - a single transient
  // lookup miss there (e.g. the router's DHCP lease for this device not
  // visible yet at that exact moment) left it blank for the rest of the
  // session. Free movies never check the MAC at all, so this went unnoticed
  // until a customer tried a paid one, and every attempt then failed with
  // "Valid MAC address required" from the server even while genuinely
  // connected through the portal. Re-detect right here, at the actual
  // payment gate, instead of trusting a possibly-stale value from load time.
  if (!onlineCurrentMac) {
    onlineCurrentMac = await detectMacForMovies();
  }
  if (!onlineCurrentMac) {
    alert('Could not identify your device on the network. Please reconnect to WiFi and try again.');
    return;
  }

  try {
    const res = await fetch('/api/coin/pending', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac: onlineCurrentMac, mode: 'online_movie', online_movie_id: movie.id })
    });
    if (res.status === 409) {
      alert('The coin slot is busy with another customer right now. Please wait a moment.');
      return;
    }
    const data = await res.json();
    if (!data.success) {
      alert(data.message || 'Could not start coin insertion.');
      return;
    }
  } catch (e) {
    alert('Could not reach the server, please try again.');
    return;
  }

  await fetch('/api/portal/relay/on', { method: 'POST' }).catch(() => {});
  showOnlineRentInsertingStep(movie);
}

function showOnlineRentInsertingStep(movie) {
  document.getElementById('movieRentDesc').innerHTML =
    `Inserted so far: <b id="onlineMovieRentRunningTotal">₱0</b> of ₱${movie.price_pesos}`;
  document.getElementById('movieRentTitle').textContent = 'Insert coins now';
  document.getElementById('movieRentConfirmBtn').textContent = 'Done';
  document.getElementById('movieRentConfirmBtn').onclick = () => finishOnlineMovieCoinInsertion(movie.id);

  clearInterval(onlineMovieCoinPollInterval);
  onlineMovieCoinPollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/coin/pending/${encodeURIComponent(onlineCurrentMac)}`);
      const data = await res.json();
      const totalEl = document.getElementById('onlineMovieRentRunningTotal');
      if (totalEl) totalEl.textContent = `₱${data.total || 0}`;
      if (!data.pending) {
        clearInterval(onlineMovieCoinPollInterval);
        await loadOnlineMovies();
        await refreshMovieCredit();
        const refreshed = onlineAllMovies.find((m) => m.id === movie.id);
        if (refreshed && refreshed.unlocked) {
          closeOnlineRentOverlay();
          startOnlinePlayback(refreshed);
        } else {
          closeOnlineRentOverlay();
          alert("That wasn't enough to unlock this movie, but it wasn't lost - it's saved as Movie Credit and you can use it for WiFi time.");
        }
      }
    } catch (e) {}
  }, 2000);
}

async function finishOnlineMovieCoinInsertion(movieId) {
  clearInterval(onlineMovieCoinPollInterval);
  try {
    const res = await fetch('/api/coin/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac: onlineCurrentMac })
    });
    const data = await res.json();
    await fetch('/api/portal/relay/off', { method: 'POST' }).catch(() => {});
    closeOnlineRentOverlay();
    await refreshMovieCredit();
    if (data.success && data.movie_unlocked) {
      if (data.change_credited > 0) {
        alert(`Unlocked! Your extra ₱${data.change_credited} was saved as Movie Credit for WiFi time.`);
      }
      await loadOnlineMovies();
      const movie = onlineAllMovies.find((m) => m.id === movieId);
      if (movie) startOnlinePlayback(movie);
    } else if (data.credited_to_balance) {
      alert(`That wasn't enough to unlock this movie (needed ₱${data.needed}), but your ₱${data.credited_to_balance} is saved as Movie Credit - use it for WiFi time whenever you like.`);
      await loadOnlineMovies();
    } else {
      alert(data.message || `Not enough was inserted (needed ₱${data.needed || ''}). Please try again.`);
      await loadOnlineMovies();
    }
  } catch (e) {
    alert('Could not reach the server, please try again.');
  }
}

async function refreshMovieCredit() {
  try {
    const res = await fetch(`/api/portal/credit/${encodeURIComponent(onlineCurrentMac)}`);
    const data = await res.json();
    const banner = document.getElementById('movieCreditBanner');
    if (data.balance_pesos > 0) {
      document.getElementById('movieCreditAmount').textContent = `₱${data.balance_pesos}`;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  } catch (e) {}
}

async function useMovieCredit() {
  const btn = document.getElementById('movieCreditUseBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/portal/credit/use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac: onlineCurrentMac })
    });
    const data = await res.json();
    if (data.success) {
      alert(`Added ${data.minutes_added} minutes of WiFi time from your Movie Credit!`);
    } else {
      alert(data.message || 'Could not use your credit right now.');
    }
    await refreshMovieCredit();
  } catch (e) {
    alert('Could not reach the server, please try again.');
  } finally {
    btn.disabled = false;
  }
}

function closeOnlineRentOverlay() {
  clearInterval(onlineMovieCoinPollInterval);
  fetch('/api/portal/relay/off', { method: 'POST' }).catch(() => {});
  document.getElementById('movieRentOverlay').classList.remove('show');
  onlinePendingRentMovieId = null;
}

// Streaming Sources (server/services list, admin panel's Movies > Online >
// Streaming Sources) - fetched once and cached, since they rarely change
// and every movie shares the same list of servers.
let onlineSources = null;
let onlineCurrentMovie = null;
let onlineCurrentSourceId = null;

async function getOnlineSources() {
  if (onlineSources) return onlineSources;
  try {
    const res = await fetch('/api/portal/online-movies/sources');
    const data = await res.json();
    onlineSources = data.sources || [];
  } catch (e) {
    onlineSources = [];
  }
  return onlineSources;
}

function renderSourceTabs(sources, activeId) {
  const el = document.getElementById('onlineSourceTabs');
  if (sources.length <= 1) {
    el.classList.remove('show');
    el.innerHTML = '';
    return;
  }
  el.innerHTML = sources.map((s) => `
    <button class="online-source-tab ${s.id === activeId ? 'active' : ''}" data-source-id="${s.id}">${escapeHtmlMovies(s.name)}</button>
  `).join('');
  el.classList.add('show');
}

async function startOnlinePlayback(movie, sourceId) {
  onlineCurrentMovie = movie;
  document.getElementById('onlineMoviePlayerTitle').textContent = movie.title;
  document.getElementById('onlineMoviePlayerOverlay').classList.add('show');

  const sources = await getOnlineSources();
  try {
    const url = `/api/portal/online-movies/${movie.id}/embed?mac=${encodeURIComponent(onlineCurrentMac)}` + (sourceId ? `&source_id=${sourceId}` : '');
    const res = await fetch(url);
    const data = await res.json();
    if (!data.success) {
      closeOnlineMoviePlayer();
      alert(data.message || 'Not available.');
      return;
    }
    onlineCurrentSourceId = data.source_id;
    renderSourceTabs(sources, data.source_id);
    document.getElementById('onlineMoviePlayerFrame').src = data.embed_url;
  } catch (e) {
    closeOnlineMoviePlayer();
    alert('Could not reach the server, please try again.');
  }
}

document.getElementById('onlineSourceTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.online-source-tab');
  if (!btn || !onlineCurrentMovie) return;
  startOnlinePlayback(onlineCurrentMovie, parseInt(btn.dataset.sourceId, 10));
});

function closeOnlineMoviePlayer() {
  document.getElementById('onlineMoviePlayerFrame').src = '';
  document.getElementById('onlineMoviePlayerOverlay').classList.remove('show');
  document.getElementById('onlineSourceTabs').classList.remove('show');
  onlineCurrentMovie = null;
}

document.getElementById('onlineMoviesSearch').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  if (!q) {
    renderOnlineMoviesRows();
    return;
  }
  const combined = [...onlineAllMovies, ...allMovies];
  renderOnlineMoviesFlat(combined.filter((m) => m.title.toLowerCase().includes(q)));
});

// Local/Online source toggle is hidden (movies.html) - the two catalogs are
// merged into one set of rows here instead, per owner request that
// customers see a single Movies experience rather than separate tabs.
// loadMovies() (movies.js) populates the local library; loadOnlineMovies()
// above populates the TMDb-backed one. Detects the MAC exactly once here
// and hands it to both (their own detectMacForMovies() calls are guarded
// to skip re-detecting) - doing it twice in parallel used to fire two
// near-simultaneous /api/portal/detect requests from the same device, and
// the server's own per-IP rate limit silently blanked whichever one lost
// the race, breaking either local or online paid rentals at random.
detectMacForMovies().then((mac) => {
  currentMac = mac;
  onlineCurrentMac = mac;
  return Promise.all([loadMovies(), loadOnlineMovies()]);
}).then(() => {
  tagKind(allMovies, 'local');
  tagKind(onlineAllMovies, 'online');
  renderOnlineMoviesRows();
  refreshMovieCredit();
});
