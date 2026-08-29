// ===== MOVIES PAGE =====
// Local movie library admin - scan a folder, tag each title Free/Premium,
// set premium prices, and kick off the one-time transcode. See
// server/services/movieService.js and server/routes/admin.js's
// /movies* routes.
let moviesPollInterval = null;

async function loadMoviesPage() {
  try {
    const ffmpegCheck = await apiCall('GET', '/api/admin/movies/ffmpeg-check');
    document.getElementById('ffmpegWarning').style.display = ffmpegCheck.installed ? 'none' : 'block';
  } catch (e) {}

  try {
    const settingsData = await apiCall('GET', '/api/admin/settings');
    if (settingsData.success) {
      document.getElementById('moviesSourceDir').value = settingsData.settings.movies_source_dir || '';
      document.getElementById('movieRentalHours').value = settingsData.settings.movie_rental_hours || '48';
    }
  } catch (e) {}

  await refreshMoviesGrid();

  clearInterval(moviesPollInterval);
  moviesPollInterval = setInterval(refreshMoviesGrid, 5000);
}

async function refreshMoviesGrid() {
  const el = document.getElementById('moviesGrid');
  if (!el) { clearInterval(moviesPollInterval); return; }
  try {
    const data = await apiCall('GET', '/api/admin/movies');
    if (!data.success || !data.movies || data.movies.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;grid-column:1/-1;">No movies yet - set a folder above and click Scan.</div>';
      return;
    }
    el.innerHTML = data.movies.map(renderMovieCard).join('');
  } catch (e) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:24px;font-size:13px;grid-column:1/-1;">Could not load movies</div>';
  }
}

function renderMovieCard(m) {
  const thumbStyle = m.thumbnail_path ? `background-image:url('${m.thumbnail_path}')` : '';
  const priceRow = m.tier === 'premium'
    ? `<div class="movie-admin-row"><span>₱</span><input type="number" min="0" value="${m.price_pesos}" style="width:60px;" onchange="updateMovieField(${m.id},'price_pesos',this.value)"></div>`
    : '';
  return `
    <div class="movie-admin-card">
      <div class="movie-admin-thumb" style="${thumbStyle}">${m.thumbnail_path ? '' : '<i class="fas fa-film" style="font-size:28px;"></i>'}</div>
      <div class="movie-admin-body">
        <div class="movie-admin-title">
          <input type="text" value="${escapeHtml(m.title)}" onchange="updateMovieField(${m.id},'title',this.value)">
        </div>
        <div class="movie-admin-row">
          <select onchange="updateMovieField(${m.id},'tier',this.value)" style="font-size:12px;">
            <option value="free" ${m.tier === 'free' ? 'selected' : ''}>Free (WiFi session)</option>
            <option value="premium" ${m.tier === 'premium' ? 'selected' : ''}>Premium (rental)</option>
          </select>
        </div>
        ${priceRow}
        <div class="movie-admin-row">
          <span class="movie-admin-status ${m.status}">${m.status}</span>
        </div>
        <div class="movie-admin-actions">
          ${m.status !== 'ready' ? `<button class="btn btn-secondary" onclick="prepareMovie(${m.id})"><i class="fas fa-bolt"></i> Prepare</button>` : ''}
          <button class="btn btn-secondary" onclick="deleteMovieConfirm(${m.id})"><i class="fas fa-trash"></i></button>
        </div>
      </div>
    </div>
  `;
}

async function updateMovieField(id, field, value) {
  await apiCall('POST', `/api/admin/movies/${id}`, { [field]: value });
  refreshMoviesGrid();
}

async function prepareMovie(id) {
  await apiCall('POST', `/api/admin/movies/${id}/prepare`);
  refreshMoviesGrid();
}

async function deleteMovieConfirm(id) {
  if (!confirm('Remove this movie from the library? The transcoded copy will be deleted (the original file on disk is untouched).')) return;
  await apiCall('DELETE', `/api/admin/movies/${id}`);
  refreshMoviesGrid();
}

async function scanMoviesFolder() {
  const data = await apiCall('POST', '/api/admin/movies/scan');
  if (data.success) {
    alert(`Found ${data.total} video file(s), added ${data.added} new.`);
    refreshMoviesGrid();
  } else {
    alert(data.message || 'Scan failed');
  }
}

async function saveMoviesSettings() {
  const dir = document.getElementById('moviesSourceDir').value.trim();
  const hours = document.getElementById('movieRentalHours').value;
  await apiCall('POST', '/api/admin/settings', { movies_source_dir: dir, movie_rental_hours: String(hours) });
}

function destroyMovies() {
  clearInterval(moviesPollInterval);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
