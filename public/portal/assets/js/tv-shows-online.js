// ===== TV SHOWS (series/anime/K-drama, seasons & episodes) =====
// Mirrors public/portal/assets/js/movies-online.js's structure closely,
// against server/routes/portal.js's /tv-shows/* endpoints and
// tvCatalogService instead of onlineMovieCatalog - see that service's
// header comment for why this is a fully separate system. Rendered into
// the SAME #onlineMoviesRows container as the movie rows (see
// movies-online.js's renderOnlineMoviesRows() calling buildTvRowsHtml()
// below) rather than a separate tab, per owner request for one organized
// Movies page. Reuses onlineCurrentMac (movies-online.js) - detected once
// for the whole page, never re-detected here.

let tvAllSeries = [];
let tvSources = null;
let tvCurrentSeries = null;
let tvCurrentSeasons = [];
let tvCurrentSeasonNumber = null;
let tvCurrentEpisodes = [];
let tvCurrentSourceId = null;
let tvPendingRentSeriesId = null;

async function loadTvShows() {
  try {
    const res = await fetch(`/api/portal/tv-shows?mac=${encodeURIComponent(onlineCurrentMac)}`);
    const data = await res.json();
    tvAllSeries = (data.series || []).map((s) => {
      s._kind = 'tv';
      // Aliased so the shared bySmartOrder()/buildGenreRows() sort/group
      // logic in movies-online.js works on this list unmodified - a
      // series' "release_date" for recency-sorting purposes is when it
      // first aired, not a movie release_date field it never has.
      s.release_date = s.first_air_date;
      return s;
    });
  } catch (e) {
    tvAllSeries = [];
  }
}

// A series card looks like a movie card (poster/lock/price) plus a small
// "SERIES" badge - enough to tell a customer it's episodic without using
// "TV"/"online" system jargon, same rule as the earlier local/online movie
// merge. Dispatches to openSeriesCard, never straight to playback - a
// series has no single video to jump straight into.
function tvCardHtml(m) {
  const isPaidTier = m.tier === 'paid';
  const lock = (isPaidTier && !m.unlocked) ? '<div class="movie-card-lock"><i class="fas fa-lock"></i></div>' : '';
  const priceTag = (isPaidTier && !m.unlocked) ? `<div class="movie-card-price">₱${m.price_pesos}</div>` : '';
  const posterInner = m.poster
    ? `<img src="${m.poster}" alt="${escapeHtmlMovies(m.title)}" loading="lazy" />`
    : '<i class="fas fa-film" style="font-size:24px;"></i>';
  return `
    <div class="movie-card" onclick="openSeriesCard(${m.id})">
      <div class="movie-card-thumb">${posterInner}</div>
      <div class="movie-card-episodic-badge">SERIES</div>
      ${lock}${priceTag}
      <div class="movie-card-title">${escapeHtmlMovies(m.title)}</div>
    </div>
  `;
}

function isAnime(s) {
  return (s.genres || []).includes('Animation') && (s.origin_country || []).includes('JP');
}
function isKDrama(s) {
  return (s.origin_country || []).includes('KR') && !isAnime(s);
}

// Auto-organized per owner request: Anime and K-Drama are detected from
// TMDb's own genre + origin_country data, not manually tagged per title.
// Everything else falls into ordinary genre rows (reusing movies-online.js's
// buildGenreRows()/rowsHtml() - both already generic over any list with
// .genres/.title/.priority/.views, no TV-specific changes needed there),
// excluding whatever's already claimed by Anime/K-Drama so a title isn't
// classified twice.
function buildTvRowsHtml() {
  if (!tvAllSeries || tvAllSeries.length === 0) return '';
  const anime = tvAllSeries.filter(isAnime).sort(bySmartOrder);
  const kdrama = tvAllSeries.filter(isKDrama).sort(bySmartOrder);
  const remaining = tvAllSeries.filter((s) => !isAnime(s) && !isKDrama(s));

  const animeRow = anime.length >= MIN_ROW_SIZE ? `
    <div class="movies-online-row">
      <h3 class="movies-online-row-title">🎌 Anime</h3>
      <div class="movies-online-row-track">${anime.map(movieCardHtml).join('')}</div>
    </div>
  ` : '';
  const kdramaRow = kdrama.length >= MIN_ROW_SIZE ? `
    <div class="movies-online-row">
      <h3 class="movies-online-row-title">🇰🇷 K-Drama</h3>
      <div class="movies-online-row-track">${kdrama.map(movieCardHtml).join('')}</div>
    </div>
  ` : '';
  const genreRows = buildGenreRows(remaining);
  return animeRow + kdramaRow + rowsHtml(genreRows);
}

function logTvSearchHitIfSearching(seriesId) {
  const box = document.getElementById('onlineMoviesSearch');
  const query = box ? box.value.trim() : '';
  if (!query) return;
  fetch('/api/portal/tv-shows/search-hit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, series_id: seriesId }),
  }).catch(() => {});
}

function openSeriesCard(id) {
  const series = tvAllSeries.find((s) => s.id === id);
  if (!series) return;
  logTvSearchHitIfSearching(id);

  if (series.tier === 'paid' && !series.unlocked) {
    tvPendingRentSeriesId = id;
    showTvRentConfirmStep(series);
    return;
  }
  openSeriesDetail(series);
}

// Same credit-aware confirm step as showOnlineRentConfirmStep() in
// movies-online.js - checked fresh every time, never cached, see that
// function's comment for why a stale read here can only under-promise,
// never over-promise.
async function showTvRentConfirmStep(series) {
  let creditBalance = 0;
  try {
    const res = await fetch(`/api/portal/credit/${encodeURIComponent(onlineCurrentMac)}`);
    const data = await res.json();
    creditBalance = data.balance_pesos || 0;
  } catch (e) {}
  const amountToPay = Math.max(0, series.price_pesos - creditBalance);

  document.getElementById('movieRentTitle').textContent = series.title;
  const btn = document.getElementById('movieRentConfirmBtn');
  if (amountToPay === 0) {
    document.getElementById('movieRentDesc').textContent =
      `You have ₱${creditBalance} Movie Credit - enough to unlock every episode of this series without inserting any coins.`;
    btn.textContent = `Unlock with ₱${series.price_pesos} Credit`;
    btn.onclick = () => unlockTvSeriesWithCredit(series);
  } else {
    document.getElementById('movieRentDesc').textContent = creditBalance > 0
      ? `You have ₱${creditBalance} Movie Credit applied. Insert ₱${amountToPay} more in coins to unlock every episode of this series.`
      : `Insert ₱${series.price_pesos} in coins to unlock every season and episode of this series. This is a separate payment from your WiFi time.`;
    btn.textContent = `Insert ₱${amountToPay} to unlock`;
    btn.onclick = () => beginTvSeriesCoinInsertion(amountToPay);
  }
  document.getElementById('movieRentOverlay').classList.add('show');
}

async function unlockTvSeriesWithCredit(series) {
  const btn = document.getElementById('movieRentConfirmBtn');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/portal/tv-shows/${series.id}/unlock-with-credit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac: onlineCurrentMac }),
    });
    const data = await res.json();
    if (!data.success) {
      alert(data.message || 'Could not unlock with credit.');
      return;
    }
    closeRentOverlay();
    await loadTvShows();
    await refreshMovieCredit();
    const refreshed = tvAllSeries.find((s) => s.id === series.id);
    if (refreshed) openSeriesDetail(refreshed);
  } catch (e) {
    alert('Could not reach the server, please try again.');
  } finally {
    btn.disabled = false;
  }
}

let tvCoinPollInterval = null;

async function beginTvSeriesCoinInsertion(amountToPay) {
  const series = tvAllSeries.find((s) => s.id === tvPendingRentSeriesId);
  if (!series) return;

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
      body: JSON.stringify({ mac: onlineCurrentMac, mode: 'tv_series', tv_series_id: series.id })
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
  showTvRentInsertingStep(series, amountToPay);
}

function showTvRentInsertingStep(series, amountToPay) {
  document.getElementById('movieRentDesc').innerHTML =
    `Inserted so far: <b id="tvRentRunningTotal">₱0</b> of ₱${amountToPay}`;
  document.getElementById('movieRentTitle').textContent = 'Insert coins now';
  document.getElementById('movieRentConfirmBtn').textContent = 'Done';
  document.getElementById('movieRentConfirmBtn').onclick = () => finishTvCoinInsertion(series.id);

  clearInterval(tvCoinPollInterval);
  tvCoinPollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/coin/pending/${encodeURIComponent(onlineCurrentMac)}`);
      const data = await res.json();
      const totalEl = document.getElementById('tvRentRunningTotal');
      if (totalEl) totalEl.textContent = `₱${data.total || 0}`;
      if (!data.pending) {
        clearInterval(tvCoinPollInterval);
        await loadTvShows();
        await refreshMovieCredit();
        const refreshed = tvAllSeries.find((s) => s.id === series.id);
        if (refreshed && refreshed.unlocked) {
          closeRentOverlay();
          openSeriesDetail(refreshed);
        } else {
          closeRentOverlay();
          alert("That wasn't enough to unlock this series, but it wasn't lost - it's saved as Movie Credit and you can use it for WiFi time or another title.");
        }
      }
    } catch (e) {}
  }, 2000);
}

async function finishTvCoinInsertion(seriesId) {
  clearInterval(tvCoinPollInterval);
  try {
    const res = await fetch('/api/coin/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac: onlineCurrentMac })
    });
    const data = await res.json();
    await fetch('/api/portal/relay/off', { method: 'POST' }).catch(() => {});
    closeRentOverlay();
    if (data.success && data.result?.series_unlocked) {
      await loadTvShows();
      const series = tvAllSeries.find((s) => s.id === seriesId);
      if (series) openSeriesDetail(series);
    } else {
      await refreshMovieCredit();
      alert('Not enough was inserted to unlock this series. Please try again.');
    }
  } catch (e) {
    alert('Could not reach the server, please try again.');
  }
}

// ===== SERIES DETAIL (seasons & episodes) =====
async function openSeriesDetail(series) {
  tvCurrentSeries = series;
  document.getElementById('seriesDetailTitle').textContent = series.title;
  document.getElementById('seriesDetailSeasonTabs').innerHTML = '';
  document.getElementById('seriesDetailEpisodes').innerHTML = '<div style="text-align:center;color:#aaa;padding:20px;">Loading seasons…</div>';
  document.getElementById('seriesDetailOverlay').classList.add('show');

  try {
    const res = await fetch(`/api/portal/tv-shows/${series.id}/seasons`);
    const data = await res.json();
    if (!data.success || !data.seasons || data.seasons.length === 0) {
      document.getElementById('seriesDetailEpisodes').innerHTML = '<div style="text-align:center;color:#aaa;padding:20px;">No seasons found.</div>';
      return;
    }
    tvCurrentSeasons = data.seasons;
    renderSeasonTabs(data.seasons[0].season_number);
    await loadSeriesEpisodes(data.seasons[0].season_number);
  } catch (e) {
    document.getElementById('seriesDetailEpisodes').innerHTML = '<div style="text-align:center;color:#aaa;padding:20px;">Could not load seasons.</div>';
  }
}

function renderSeasonTabs(activeSeasonNumber) {
  const el = document.getElementById('seriesDetailSeasonTabs');
  el.innerHTML = tvCurrentSeasons.map((s) => `
    <button class="series-season-tab ${s.season_number === activeSeasonNumber ? 'active' : ''}" data-season="${s.season_number}">${escapeHtmlMovies(s.name)}</button>
  `).join('');
}

document.getElementById('seriesDetailSeasonTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.series-season-tab');
  if (!btn) return;
  const seasonNumber = parseInt(btn.dataset.season, 10);
  renderSeasonTabs(seasonNumber);
  loadSeriesEpisodes(seasonNumber);
});

async function loadSeriesEpisodes(seasonNumber) {
  tvCurrentSeasonNumber = seasonNumber;
  const el = document.getElementById('seriesDetailEpisodes');
  el.innerHTML = '<div style="text-align:center;color:#aaa;padding:20px;">Loading episodes…</div>';
  try {
    const res = await fetch(`/api/portal/tv-shows/${tvCurrentSeries.id}/season/${seasonNumber}/episodes`);
    const data = await res.json();
    if (!data.success || !data.episodes || data.episodes.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:#aaa;padding:20px;">No episodes found for this season.</div>';
      return;
    }
    tvCurrentEpisodes = data.episodes;
    el.innerHTML = data.episodes.map((ep) => `
      <div class="series-episode-row" data-episode="${ep.episode_number}">
        <div class="series-episode-thumb"${ep.still_path ? ` style="background-image:url('https://image.tmdb.org/t/p/w200${ep.still_path}')"` : ''}>${ep.still_path ? '' : '<i class="fas fa-play"></i>'}</div>
        <div class="series-episode-info">
          <div class="series-episode-title">${ep.episode_number}. ${escapeHtmlMovies(ep.name)}</div>
          <div class="series-episode-meta">${ep.air_date || ''}</div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = '<div style="text-align:center;color:#aaa;padding:20px;">Could not load episodes.</div>';
  }
}

document.getElementById('seriesDetailEpisodes').addEventListener('click', (e) => {
  const row = e.target.closest('.series-episode-row');
  if (!row) return;
  playTvEpisode(parseInt(row.dataset.episode, 10));
});

function closeSeriesDetail() {
  document.getElementById('seriesDetailOverlay').classList.remove('show');
  tvCurrentSeries = null;
}

// ===== PLAYBACK (own overlay/iframe, deliberately not shared with the
// movie player - see movies.html's comment on #tvPlayerOverlay) =====
async function getTvSources() {
  if (tvSources) return tvSources;
  try {
    const res = await fetch('/api/portal/tv-shows/sources');
    const data = await res.json();
    tvSources = data.sources || [];
  } catch (e) {
    tvSources = [];
  }
  return tvSources;
}

function renderTvSourceTabs(sources, activeId) {
  const el = document.getElementById('tvSourceTabs');
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

async function playTvEpisode(episodeNumber, sourceId) {
  const series = tvCurrentSeries;
  const season = tvCurrentSeasonNumber;
  if (!series || !season) return;

  document.getElementById('seriesDetailOverlay').classList.remove('show');
  const episode = tvCurrentEpisodes.find((e) => e.episode_number === episodeNumber);
  document.getElementById('tvPlayerTitle').textContent = `${series.title} · S${season}E${episodeNumber}${episode ? ' - ' + episode.name : ''}`;
  document.getElementById('tvPlayerOverlay').classList.add('show');

  const sources = await getTvSources();
  try {
    const url = `/api/portal/tv-shows/${series.id}/embed?mac=${encodeURIComponent(onlineCurrentMac)}&season=${season}&episode=${episodeNumber}` + (sourceId ? `&source_id=${sourceId}` : '');
    const res = await fetch(url);
    const data = await res.json();
    if (!data.success) {
      closeTvPlayer();
      alert(data.message || 'Not available.');
      return;
    }
    tvCurrentSourceId = data.source_id;
    renderTvSourceTabs(sources, data.source_id);
    document.getElementById('tvPlayerFrame').src = data.embed_url;
  } catch (e) {
    closeTvPlayer();
    alert('Could not reach the server, please try again.');
  }
}

document.getElementById('tvSourceTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.online-source-tab');
  if (!btn || !tvCurrentSeries) return;
  playTvEpisode(tvCurrentEpisodeNumberPlaying(), parseInt(btn.dataset.sourceId, 10));
});

// The currently-playing episode number isn't tracked in a separate
// variable - the player's title already encodes it, but a source switch
// needs the raw number back out. Simplest reliable source: re-derive it
// from the title we just set, rather than adding yet another module-level
// variable purely to mirror it.
function tvCurrentEpisodeNumberPlaying() {
  const match = /S\d+E(\d+)/.exec(document.getElementById('tvPlayerTitle').textContent);
  return match ? parseInt(match[1], 10) : null;
}

function closeTvPlayer() {
  document.getElementById('tvPlayerFrame').src = '';
  document.getElementById('tvPlayerOverlay').classList.remove('show');
  document.getElementById('tvSourceTabs').classList.remove('show');
}

// Kicks off the whole page's init (movies-online.js's startUnifiedMoviesInit) -
// called from HERE, the last <script> tag movies.html loads, specifically so
// loadMovies/loadOnlineMovies/loadTvShows are all guaranteed defined by the
// time it runs. See that function's own comment for the script-load race
// this replaced (calling it from movies-online.js's own bottom could fire
// before this file had finished loading, silently skipping the TV catalog).
startUnifiedMoviesInit();
