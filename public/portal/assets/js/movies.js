// ===== MOVIES BROWSE + PLAYER =====
// Free titles unlock with any active WiFi session; premium titles ALWAYS
// need their own separate per-device coin payment (server/routes/coin.js's
// mode:'movie' pending-coin branch), regardless of how much WiFi time the
// device has. See server/services/movieService.js for the transcode
// pipeline.
let allMovies = [];
let moviesTierFilter = '';
let currentMac = '';
let hlsInstance = null;
let playPollInterval = null;
let pendingRentMovieId = null;

async function detectMacForMovies() {
  const params = new URLSearchParams(window.location.search);
  const urlMac = params.get('mac');
  if (urlMac) return urlMac;
  try {
    const res = await fetch('/api/portal/detect');
    const data = await res.json();
    return data.mac || '';
  } catch (e) {
    return '';
  }
}

async function loadMovies() {
  currentMac = await detectMacForMovies();
  try {
    const res = await fetch(`/api/portal/movies?mac=${encodeURIComponent(currentMac)}`);
    const data = await res.json();
    allMovies = data.movies || [];
    renderMoviesGrid();
  } catch (e) {
    document.getElementById('moviesEmptyState').style.display = 'block';
  }
}

function setMoviesTierFilter(tier) {
  moviesTierFilter = tier;
  document.querySelectorAll('.movies-tab').forEach((t) => t.classList.toggle('active', t.dataset.tier === tier));
  renderMoviesGrid();
}

function renderMoviesGrid() {
  const el = document.getElementById('moviesGridPortal');
  const empty = document.getElementById('moviesEmptyState');
  const filtered = moviesTierFilter ? allMovies.filter((m) => m.tier === moviesTierFilter) : allMovies;

  if (filtered.length === 0) {
    el.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  el.innerHTML = filtered.map((m) => {
    const thumbStyle = m.thumbnail_path ? `background-image:url('${m.thumbnail_path}')` : '';
    const lock = !m.unlocked ? '<div class="movie-card-lock"><i class="fas fa-lock"></i></div>' : '';
    const priceTag = (m.tier === 'premium' && !m.unlocked) ? `<div class="movie-card-price">₱${m.price_pesos}</div>` : '';
    return `
      <div class="movie-card" onclick="openMovie(${m.id})">
        <div class="movie-card-thumb" style="${thumbStyle}">${m.thumbnail_path ? '' : '<i class=\"fas fa-film\" style=\"font-size:24px;\"></i>'}</div>
        ${lock}${priceTag}
        <div class="movie-card-title">${escapeHtmlMovies(m.title)}</div>
      </div>
    `;
  }).join('');
}

function openMovie(id) {
  const movie = allMovies.find((m) => m.id === id);
  if (!movie) return;

  if (!movie.unlocked) {
    if (movie.tier === 'free') {
      alert('You need active WiFi time to watch this. Insert a coin on the main portal page first.');
      return;
    }
    pendingRentMovieId = id;
    showRentConfirmStep(movie);
    return;
  }

  startPlayback(movie);
}

// This is a REAL, separate coin payment - not a deduction from WiFi time
// (even a customer with hours of WiFi left still has to physically pay
// this amount, matching the "insert an actual ₱10" requirement rather
// than spending time they already bought). Drives the exact same
// pending-coin mechanism the main portal's Insert Coin modal uses
// (server/routes/coin.js), just tagged mode:'movie' so
// finalizePendingCoins() unlocks the movie_rentals row instead of
// crediting session minutes.
function showRentConfirmStep(movie) {
  document.getElementById('movieRentTitle').textContent = movie.title;
  document.getElementById('movieRentDesc').textContent =
    `Insert ₱${movie.price_pesos} in coins to unlock this movie. This is a separate payment from your WiFi time.`;
  document.getElementById('movieRentConfirmBtn').textContent = `Insert ₱${movie.price_pesos} to unlock`;
  document.getElementById('movieRentConfirmBtn').onclick = beginMovieCoinInsertion;
  document.getElementById('movieRentOverlay').classList.add('show');
}

let movieCoinPollInterval = null;

async function beginMovieCoinInsertion() {
  const movie = allMovies.find((m) => m.id === pendingRentMovieId);
  if (!movie) return;

  try {
    const res = await fetch('/api/coin/pending', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac: currentMac, mode: 'movie', movie_id: movie.id })
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
  showRentInsertingStep(movie);
}

function showRentInsertingStep(movie) {
  document.getElementById('movieRentDesc').innerHTML =
    `Inserted so far: <b id="movieRentRunningTotal">₱0</b> of ₱${movie.price_pesos}`;
  document.getElementById('movieRentTitle').textContent = 'Insert coins now';
  document.getElementById('movieRentConfirmBtn').textContent = 'Done';
  document.getElementById('movieRentConfirmBtn').onclick = () => finishMovieCoinInsertion(movie.id);

  clearInterval(movieCoinPollInterval);
  movieCoinPollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/coin/pending/${encodeURIComponent(currentMac)}`);
      const data = await res.json();
      const totalEl = document.getElementById('movieRentRunningTotal');
      if (totalEl) totalEl.textContent = `₱${data.total || 0}`;
      if (!data.pending) {
        // Window closed on its own (silence timeout) - see if it unlocked.
        clearInterval(movieCoinPollInterval);
        await loadMovies();
        const refreshed = allMovies.find((m) => m.id === movie.id);
        if (refreshed && refreshed.unlocked) {
          closeRentOverlay();
          startPlayback(refreshed);
        } else {
          closeRentOverlay();
          alert('Not enough was inserted to unlock this movie. Please try again.');
        }
      }
    } catch (e) {}
  }, 2000);
}

async function finishMovieCoinInsertion(movieId) {
  clearInterval(movieCoinPollInterval);
  try {
    const res = await fetch('/api/coin/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac: currentMac })
    });
    const data = await res.json();
    await fetch('/api/portal/relay/off', { method: 'POST' }).catch(() => {});
    closeRentOverlay();
    if (data.success && data.result?.movie_unlocked) {
      await loadMovies();
      const movie = allMovies.find((m) => m.id === movieId);
      if (movie) startPlayback(movie);
    } else {
      alert(data.message || `Not enough was inserted (needed ₱${data.needed || ''}). Please try again.`);
      await loadMovies();
    }
  } catch (e) {
    alert('Could not reach the server, please try again.');
  }
}

function closeRentOverlay() {
  clearInterval(movieCoinPollInterval);
  fetch('/api/portal/relay/off', { method: 'POST' }).catch(() => {});
  document.getElementById('movieRentOverlay').classList.remove('show');
  pendingRentMovieId = null;
}

function startPlayback(movie) {
  document.getElementById('moviePlayerTitle').textContent = movie.title;
  document.getElementById('moviePlayerOverlay').classList.add('show');
  document.getElementById('moviePlayerStatus').textContent = '';
  pollForPlayback(movie.id);
}

async function pollForPlayback(id) {
  clearInterval(playPollInterval);
  const check = async () => {
    try {
      const res = await fetch(`/api/portal/movies/${id}/play?mac=${encodeURIComponent(currentMac)}`);
      const data = await res.json();
      if (!data.success) {
        document.getElementById('moviePlayerStatus').textContent = data.message || 'Not available.';
        clearInterval(playPollInterval);
        return;
      }
      if (data.status === 'ready') {
        clearInterval(playPollInterval);
        document.getElementById('moviePlayerStatus').textContent = '';
        playHls(data.hls_url);
      } else {
        document.getElementById('moviePlayerStatus').textContent = 'Preparing this movie for the first time, this only takes a moment...';
      }
    } catch (e) {}
  };
  check();
  playPollInterval = setInterval(check, 4000);
}

function playHls(url) {
  const video = document.getElementById('moviePlayerVideo');
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

  if (window.Hls && window.Hls.isSupported()) {
    hlsInstance = new Hls();
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari plays HLS natively, no library needed.
    video.src = url;
    video.play().catch(() => {});
  } else {
    document.getElementById('moviePlayerStatus').textContent = 'This browser cannot play video streaming. Try Chrome or Safari.';
  }
}

function closeMoviePlayer() {
  clearInterval(playPollInterval);
  const video = document.getElementById('moviePlayerVideo');
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  document.getElementById('moviePlayerOverlay').classList.remove('show');
}

function escapeHtmlMovies(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

loadMovies();
