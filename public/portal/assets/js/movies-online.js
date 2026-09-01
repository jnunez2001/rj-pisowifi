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

async function loadOnlineMovies() {
  onlineCurrentMac = await detectMacForMovies();
  try {
    const res = await fetch(`/api/portal/online-movies?mac=${encodeURIComponent(onlineCurrentMac)}`);
    const data = await res.json();
    onlineAllMovies = data.movies || [];
    renderOnlineMoviesRows(onlineAllMovies);
    onlineMoviesRendered = true;
  } catch (e) {
    document.getElementById('onlineMoviesRows').innerHTML = '';
  }
}

function movieCardHtml(m) {
  const lock = (m.tier === 'paid' && !m.unlocked) ? '<div class="movie-card-lock"><i class="fas fa-lock"></i></div>' : '';
  const priceTag = (m.tier === 'paid' && !m.unlocked) ? `<div class="movie-card-price">₱${m.price_pesos}</div>` : '';
  const poster = m.poster
    ? `<img src="${m.poster}" alt="${escapeHtmlMovies(m.title)}" loading="lazy" />`
    : '<i class="fas fa-film" style="font-size:24px;"></i>';
  return `
    <div class="movie-card" onclick="openOnlineMovie(${m.id})">
      <div class="movie-card-thumb">${poster}</div>
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

// Genre rows are the default view; falls back to the old tier-based
// grouping only while genres haven't finished warming yet (e.g. right after
// a fresh install, before tmdbService's background fetch completes) so the
// page still has SOME organization instead of nothing.
function renderOnlineMoviesRows(list) {
  const el = document.getElementById('onlineMoviesRows');
  const top10 = topWatchedRowHtml(list);
  const genreRows = buildGenreRows(list);
  if (genreRows.length > 0) {
    el.innerHTML = top10 + rowsHtml(genreRows);
    return;
  }
  const tierRows = TIER_ROWS
    .map(({ tier, label }) => [label, list.filter((m) => m.tier === tier)])
    .filter(([, items]) => items.length > 0);
  el.innerHTML = top10 + rowsHtml(tierRows);
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
    renderOnlineMoviesRows(onlineAllMovies);
    return;
  }
  renderOnlineMoviesFlat(onlineAllMovies.filter((m) => m.title.toLowerCase().includes(q)));
});

// Local tab is hidden for now (movies.html) - load Online straight away
// instead of waiting for a tab click.
loadOnlineMovies().then(refreshMovieCredit);
