// ===== MOVIES BROWSE + PLAYER =====
// Free titles unlock with any active WiFi session; premium titles need a
// per-device rental (paid out of already-credited WiFi minutes - see
// server/routes/portal.js's POST /movies/:id/rent). See
// server/services/movieService.js for the transcode pipeline.
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
    document.getElementById('movieRentTitle').textContent = movie.title;
    document.getElementById('movieRentDesc').textContent =
      `Unlock this movie for ₱${movie.price_pesos} of your WiFi time. You'll be able to watch it for a limited rental window.`;
    document.getElementById('movieRentConfirmBtn').textContent = `Unlock for ₱${movie.price_pesos}`;
    document.getElementById('movieRentOverlay').classList.add('show');
    return;
  }

  startPlayback(movie);
}

function closeRentOverlay() {
  document.getElementById('movieRentOverlay').classList.remove('show');
  pendingRentMovieId = null;
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('movieRentConfirmBtn');
  if (btn) btn.onclick = confirmRentMovie;
});

async function confirmRentMovie() {
  if (!pendingRentMovieId) return;
  try {
    const res = await fetch(`/api/portal/movies/${pendingRentMovieId}/rent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac: currentMac })
    });
    const data = await res.json();
    if (data.success) {
      closeRentOverlay();
      await loadMovies();
      const movie = allMovies.find((m) => m.id === pendingRentMovieId);
      if (movie) startPlayback(movie);
    } else {
      alert(data.message || 'Could not unlock this movie.');
    }
  } catch (e) {
    alert('Could not reach the server, please try again.');
  }
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
