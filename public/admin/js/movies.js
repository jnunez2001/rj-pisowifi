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
  // Bug found live: Scan only ever read the folder path from the saved
  // DB setting, never the input field directly - if Save hadn't
  // actually completed first (silent failure, or just never clicked),
  // Scan reported "No movies folder configured" even with a path
  // visibly typed in the box. Saving here first closes that gap - Scan
  // now always reflects whatever's currently in the field.
  const saved = await saveMoviesSettings();
  if (!saved) return;

  const data = await apiCall('POST', '/api/admin/movies/scan');
  if (data.success) {
    showToast(`Found ${data.total} video file(s), added ${data.added} new.`, 'success');
    refreshMoviesGrid();
  } else {
    showToast(data.message || 'Scan failed', 'error');
  }
}

// Returns true/false so scanMoviesFolder() can bail out before scanning
// if the save itself failed, instead of scanning against a stale setting.
async function saveMoviesSettings() {
  const dir = document.getElementById('moviesSourceDir').value.trim();
  const hours = document.getElementById('movieRentalHours').value;
  try {
    const data = await apiCall('POST', '/api/admin/settings', { movies_source_dir: dir, movie_rental_hours: String(hours) });
    if (data.success) {
      showToast('Movies settings saved', 'success');
      return true;
    }
    showToast(data.message || 'Could not save movies settings', 'error');
    return false;
  } catch (e) {
    showToast('Server error saving movies settings', 'error');
    return false;
  }
}

function destroyMovies() {
  clearInterval(moviesPollInterval);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
