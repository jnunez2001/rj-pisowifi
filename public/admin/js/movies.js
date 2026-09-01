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
  await omInit();

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
  clearTimeout(omSearchDebounce);
  clearTimeout(omFilterDebounce);
  clearTimeout(omRentalsFilterDebounce);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ===== ONLINE MOVIES (server/services/onlineMovieCatalog.js + tmdbService.js) =====
// Purely additive to everything above - the local movie library's grid,
// scan, and settings are untouched by any of this.
const omState = { page: 1, limit: 30, filter: '', tier: '', total: 0 };
let omSearchDebounce = null;
let omFilterDebounce = null;

async function omInit() {
  try {
    const data = await apiCall('GET', '/api/admin/movies/online-settings');
    if (data.success) {
      omSetPill('omTmdbStatus', data.tmdb_key_set);
      omRenderFeedStatus(data.feed);
    }
  } catch (e) {}
  await omLoadSources();
  omState.page = 1;
  await omLoadCatalog();
  await omLoadRentals();
  await omLoadTopSearches();
}

function omSetPill(elId, isSet) {
  const pill = document.getElementById(elId);
  pill.textContent = isSet ? 'CONFIGURED' : 'NOT SET';
  pill.className = 'om-status-pill' + (isSet ? ' set' : '');
}

function omRenderFeedStatus(feed) {
  const el = document.getElementById('omFeedStatus');
  if (!feed || !feed.count) { el.textContent = 'Not synced yet.'; return; }
  const when = feed.last_synced ? new Date(feed.last_synced.replace(' ', 'T') + 'Z').toLocaleString() : 'unknown';
  el.textContent = `${feed.count} titles synced · last run ${when}`;
}

// ── Streaming Sources ("Server 1", "Server 2", ...) ─────────────────────
async function omLoadSources() {
  const data = await apiCall('GET', '/api/admin/movies/streaming-sources');
  const tbody = document.getElementById('omSourcesRows');
  const sources = data.success ? data.sources : [];
  omSetPill('omSourceStatus', sources.length > 0);
  if (sources.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:16px;">No sources yet - add one below.</td></tr>';
    return;
  }
  tbody.innerHTML = sources.map((s) => `
    <tr data-source-id="${s.id}">
      <td style="text-align:center;">
        <i class="fas fa-star om-default-star ${s.is_default ? 'active' : ''}" title="Default source" style="cursor:pointer;"></i>
      </td>
      <td><input type="text" class="om-source-name" value="${escapeHtml(s.name)}" style="width:100%;"></td>
      <td><input type="text" class="om-source-url" value="${escapeHtml(s.url_template)}" style="width:100%;"></td>
      <td style="text-align:right;">
        <button class="btn btn-secondary om-source-remove" style="padding:4px 8px;font-size:11px;"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `).join('');
}

async function omAddSource() {
  const name = document.getElementById('omNewSourceName').value.trim();
  const url_template = document.getElementById('omNewSourceUrl').value.trim();
  if (!name || !url_template) { showToast('Enter both a name and a URL', 'error'); return; }
  const data = await apiCall('POST', '/api/admin/movies/streaming-sources', { name, url_template });
  if (data.success) {
    showToast(`"${name}" added`, 'success');
    document.getElementById('omNewSourceName').value = '';
    document.getElementById('omNewSourceUrl').value = '';
    omLoadSources();
  } else {
    showToast(data.message || 'Could not add source', 'error');
  }
}

async function omSaveSourceRow(row) {
  const id = row.dataset.sourceId;
  const name = row.querySelector('.om-source-name').value.trim();
  const url_template = row.querySelector('.om-source-url').value.trim();
  const data = await apiCall('POST', `/api/admin/movies/streaming-sources/${id}`, { name, url_template });
  if (data.success) showToast('Source updated', 'success');
  else showToast(data.message || 'Could not save', 'error');
}

async function omSetDefaultSource(row) {
  const id = row.dataset.sourceId;
  await apiCall('POST', `/api/admin/movies/streaming-sources/${id}`, { is_default: true });
  omLoadSources();
}

async function omRemoveSource(row) {
  if (!confirm('Remove this streaming source?')) return;
  await apiCall('DELETE', `/api/admin/movies/streaming-sources/${row.dataset.sourceId}`);
  omLoadSources();
}

function omToggleReveal() {
  const input = document.getElementById('omTmdbInput');
  const btn = event.target;
  if (input.type === 'password') { input.type = 'text'; btn.textContent = 'HIDE'; }
  else { input.type = 'password'; btn.textContent = 'SHOW'; }
}

async function omSaveTmdb() {
  const api_key = document.getElementById('omTmdbInput').value.trim();
  if (!api_key) { showToast('Enter a key first', 'error'); return; }
  const data = await apiCall('POST', '/api/admin/movies/tmdb-key', { api_key });
  if (data.success) {
    showToast('TMDb key saved', 'success');
    omSetPill('omTmdbStatus', true);
    document.getElementById('omTmdbInput').value = '';
    document.getElementById('omTmdbInput').placeholder = 'Paste your TMDb API key (already set)';
  } else {
    showToast(data.message || 'Could not save', 'error');
  }
}

async function omTestTmdb() {
  const api_key = document.getElementById('omTmdbInput').value.trim();
  const box = document.getElementById('omTestResult');
  box.className = 'om-test-result show';
  box.textContent = 'Testing…';
  const data = await apiCall('POST', '/api/admin/movies/tmdb-test', api_key ? { api_key } : {});
  box.className = 'om-test-result show ' + (data.success ? 'ok' : 'fail');
  box.textContent = data.success ? '✓ Connected successfully.' : '✗ ' + (data.message || 'Connection failed.');
}

async function omSyncFeed() {
  const btn = document.getElementById('omSyncBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing…';
  try {
    const data = await apiCall('POST', '/api/admin/movies/tmdb-sync');
    if (data.success) {
      showToast(`Synced ${data.total} title(s) from TMDb`, 'success');
      const settingsData = await apiCall('GET', '/api/admin/movies/online-settings');
      if (settingsData.success) omRenderFeedStatus(settingsData.feed);
      omState.page = 1;
      await omLoadCatalog();
    } else {
      showToast(data.message || 'Sync failed', 'error');
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-cloud-arrow-down"></i> Sync Trending / Popular / Top Rated';
  }
}

function omSearchTmdb(query) {
  clearTimeout(omSearchDebounce);
  const dropdown = document.getElementById('omSearchDropdown');
  if (!query.trim()) { dropdown.classList.remove('show'); return; }
  omSearchDebounce = setTimeout(async () => {
    const data = await apiCall('GET', `/api/admin/movies/tmdb-search?q=${encodeURIComponent(query)}`);
    if (!data.success) { dropdown.innerHTML = `<div class="om-search-result">${escapeHtml(data.message || 'Search failed')}</div>`; dropdown.classList.add('show'); return; }
    if (data.results.length === 0) { dropdown.innerHTML = '<div class="om-search-result">No matches</div>'; dropdown.classList.add('show'); return; }
    // data-id/data-title instead of inline onclick("...'title'...") - a
    // title containing a quote character would otherwise break out of the
    // inline JS string literal or the HTML attribute itself. Click handled
    // by the single delegated listener at the bottom of this file.
    dropdown.innerHTML = data.results.map((m) => `
      <div class="om-search-result" data-id="${m.id}" data-title="${escapeHtml(m.title).replace(/"/g, '&quot;')}">
        <img src="${m.poster_path ? 'https://image.tmdb.org/t/p/w92' + m.poster_path : ''}" onerror="this.style.visibility='hidden'">
        <span>${escapeHtml(m.title)}</span>
        <span class="yr">${m.year || ''}</span>
      </div>
    `).join('');
    dropdown.classList.add('show');
  }, 350);
}

async function omAddFromSearch(tmdbId, title) {
  document.getElementById('omSearchDropdown').classList.remove('show');
  document.getElementById('omSearchInput').value = '';
  const data = await apiCall('POST', '/api/admin/movies/online-catalog/price', { tmdb_id: tmdbId, title, tier: 'free', price_pesos: 0 });
  if (data.success) {
    showToast(`Added "${title}" (Free by default)`, 'success');
    document.getElementById('omCatalogFilter').value = title;
    omState.filter = title;
    omState.page = 1;
    await omLoadCatalog();
  } else {
    showToast(data.message || 'Could not add', 'error');
  }
}

// Add a title directly by TMDb ID, no search needed - the server looks up
// the real title from TMDb itself so the catalog never shows a blank or
// wrong name for it.
async function omAddById() {
  const input = document.getElementById('omAddByIdInput');
  const tmdbId = parseInt(input.value, 10);
  if (!tmdbId) { showToast('Enter a numeric TMDb ID first', 'error'); return; }
  const data = await apiCall('POST', '/api/admin/movies/online-catalog/add-by-id', { tmdb_id: tmdbId, tier: 'free', price_pesos: 0 });
  if (data.success) {
    showToast(`Added "${data.title}" (Free by default)`, 'success');
    input.value = '';
    document.getElementById('omCatalogFilter').value = data.title;
    omState.filter = data.title;
    omState.page = 1;
    await omLoadCatalog();
  } else {
    showToast(data.message || 'Could not add that ID', 'error');
  }
}

// Bulk import (a .txt file, one TMDb ID per line) - uses a raw fetch with
// FormData instead of apiCall() since apiCall always JSON-encodes the
// body; a file upload needs multipart/form-data with the browser setting
// its own boundary, which happens automatically as long as Content-Type
// is left unset here.
async function omImportIds(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  document.getElementById('omImportFile').value = '';

  showToast('Importing… this can take a moment for a long list', 'info');
  try {
    const res = await fetch('/api/admin/movies/online-catalog/import', {
      method: 'POST',
      headers: { password: authToken },
      body: formData,
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Imported ${data.added} title(s) (${data.already_in_catalog} already in catalog, ${data.failed} failed)`, 'success');
      omState.page = 1;
      await omLoadCatalog();
    } else {
      showToast(data.message || 'Import failed', 'error');
    }
  } catch (e) {
    showToast('Server error during import', 'error');
  }
}

// Export fetched via JS (not a plain link) because adminAuth reads the
// password from a custom header, which a browser navigation/download link
// can't send - so the file is fetched authenticated, then handed to the
// browser as a Blob download instead.
async function omExportIds() {
  try {
    const res = await fetch('/api/admin/movies/online-catalog/export', {
      headers: { password: authToken },
    });
    if (!res.ok) { showToast('Export failed', 'error'); return; }
    const text = await res.text();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'online-movies-tmdb-ids.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast('Server error during export', 'error');
  }
}

function omFilterCatalog(value) {
  clearTimeout(omFilterDebounce);
  omFilterDebounce = setTimeout(() => {
    omState.filter = value.trim();
    omState.page = 1;
    omLoadCatalog();
  }, 350);
}

// Free/Paid filter (owner request: finding paid titles shouldn't mean
// scrolling the whole alphabetical catalog one by one) - the server also
// switches to priority/price order instead of A-Z whenever this is set,
// see GET /movies/online-catalog.
function omFilterTier(value) {
  omState.tier = value;
  omState.page = 1;
  omLoadCatalog();
}

async function omLoadCatalog() {
  const tbody = document.getElementById('omCatalogRows');
  const params = new URLSearchParams({ q: omState.filter, tier: omState.tier, page: omState.page, limit: omState.limit });
  const data = await apiCall('GET', `/api/admin/movies/online-catalog?${params.toString()}`);
  if (!data.success) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:20px;">Could not load catalog</td></tr>';
    return;
  }
  omState.total = data.total;
  if (data.movies.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:20px;">No titles match.</td></tr>';
  } else {
    tbody.innerHTML = data.movies.map(omRenderCatalogRow).join('');
  }
  document.getElementById('omSelectAll').checked = false;
  omUpdateBulkBar();
  const start = data.total === 0 ? 0 : (omState.page - 1) * omState.limit + 1;
  const end = Math.min(omState.page * omState.limit, data.total);
  document.getElementById('omTableSummary').textContent = `${start}-${end} of ${data.total} titles`;
}

// No inline onchange/onclick carrying the title as a string literal here -
// a title with a quote character would break either the HTML attribute or
// the embedded JS string. The tier <select>, price <input>, and reset
// button all just carry data-id (an event delegated at the bottom of this
// file reads the title straight off the row's own data-title).
function omRenderCatalogRow(m) {
  const poster = m.poster ? `<img src="${m.poster}">` : '<img>';
  const priceInputStyle = m.tier === 'paid' ? '' : 'display:none;';
  const titleAttr = escapeHtml(m.title).replace(/"/g, '&quot;');
  return `
    <tr data-id="${m.id}" data-title="${titleAttr}">
      <td><input type="checkbox" class="om-row-check" onclick="omUpdateBulkBar()"></td>
      <td>
        <div class="om-movie-cell">
          ${poster}
          <div><div>${escapeHtml(m.title)}</div><div class="om-movie-id">tmdb ${m.id}</div></div>
        </div>
      </td>
      <td>
        <select class="om-tier-select">
          <option value="free" ${m.tier === 'free' ? 'selected' : ''}>Free</option>
          <option value="paid" ${m.tier === 'paid' ? 'selected' : ''}>Paid</option>
        </select>
      </td>
      <td class="om-price-cell">
        <input type="number" class="om-price-input" min="0" value="${m.price_pesos || 0}" style="width:60px;text-align:right;${priceInputStyle}">
      </td>
      <td class="om-price-cell">
        <input type="number" class="om-priority-input" value="${m.priority || 0}" style="width:60px;text-align:right;" title="Higher shows first in 🔥 Exclusive and within genre rows">
      </td>
      <td class="om-price-cell">
        <input type="number" class="om-rental-hours-input" min="0" value="${m.rental_hours || 0}" style="width:70px;text-align:right;${priceInputStyle}" title="0 = use the global default">
      </td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="btn btn-secondary om-reset-btn" style="padding:4px 8px;font-size:11px;" title="Reset to Free"><i class="fas fa-rotate-left"></i></button>
        <button class="btn btn-secondary om-delete-btn" style="padding:4px 8px;font-size:11px;color:var(--danger,#e74c3c);" title="Remove from catalog"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `;
}

function omInlineSave(row) {
  const tmdbId = parseInt(row.dataset.id, 10);
  const title = row.dataset.title;
  const tier = row.querySelector('.om-tier-select').value;
  const priceInput = row.querySelector('.om-price-input');
  const rentalHoursInput = row.querySelector('.om-rental-hours-input');
  const priority = row.querySelector('.om-priority-input').value;
  priceInput.style.display = tier === 'paid' ? 'inline-block' : 'none';
  rentalHoursInput.style.display = tier === 'paid' ? 'inline-block' : 'none';
  omSavePrice(tmdbId, title, tier, priceInput.value, priority, rentalHoursInput.value);
}

async function omSavePrice(tmdbId, title, tier, priceRaw, priorityRaw, rentalHoursRaw) {
  const price_pesos = tier === 'paid' ? Math.max(0, parseInt(priceRaw, 10) || 0) : 0;
  const priority = parseInt(priorityRaw, 10) || 0;
  const rental_hours = tier === 'paid' ? Math.max(0, parseInt(rentalHoursRaw, 10) || 0) : 0;
  const data = await apiCall('POST', '/api/admin/movies/online-catalog/price', { tmdb_id: tmdbId, title, tier, price_pesos, priority, rental_hours });
  if (data.success) showToast(`"${title}" updated`, 'success');
  else showToast(data.message || 'Could not save', 'error');
}

async function omResetToFree(tmdbId) {
  await apiCall('DELETE', `/api/admin/movies/online-catalog/price/${tmdbId}`);
  showToast('Reset to Free', 'success');
  omLoadCatalog();
}

// Fully removes a title (not appropriate for customers, etc.) - unlike the
// reset button above, this also keeps it from silently coming back the next
// time "Sync from TMDb" runs (see server/services/onlineMovieCatalog.js's
// hide()). Re-adding it later by TMDb ID or search clears that block.
async function omDeleteFromCatalog(tmdbId, title) {
  if (!confirm(`Remove "${title}" from the Online Movies catalog? It won't reappear even after syncing from TMDb, until it's added back manually.`)) return;
  const data = await apiCall('DELETE', `/api/admin/movies/online-catalog/${tmdbId}`);
  if (data.success) {
    showToast(`"${title}" removed`, 'success');
    omLoadCatalog();
  } else {
    showToast(data.message || 'Could not remove', 'error');
  }
}

function omToggleAll(cb) {
  document.querySelectorAll('.om-row-check').forEach((c) => c.checked = cb.checked);
  omUpdateBulkBar();
}

function omUpdateBulkBar() {
  const n = document.querySelectorAll('.om-row-check:checked').length;
  document.getElementById('omBulkCount').textContent = n;
  document.getElementById('omBulkBar').classList.toggle('show', n > 0);
}

async function omApplyBulk() {
  const rows = [...document.querySelectorAll('.om-row-check:checked')].map((cb) => cb.closest('tr'));
  const movies = rows.map((r) => ({ tmdb_id: parseInt(r.dataset.id, 10), title: r.dataset.title }));
  const tier = document.getElementById('omBulkTier').value;
  const price_pesos = document.getElementById('omBulkPrice').value;
  const data = await apiCall('POST', '/api/admin/movies/online-catalog/bulk-price', { movies, tier, price_pesos });
  if (data.success) {
    showToast(`Updated ${data.updated} title(s)`, 'success');
    omLoadCatalog();
  } else {
    showToast(data.message || 'Could not apply', 'error');
  }
}

// Group delete - same permanent-hide semantics as the single-row Delete
// button (won't reappear on the next TMDb sync), applied to every checked
// row at once.
async function omApplyBulkDelete() {
  const rows = [...document.querySelectorAll('.om-row-check:checked')].map((cb) => cb.closest('tr'));
  if (rows.length === 0) return;
  if (!confirm(`Remove ${rows.length} selected title(s) from the catalog? They won't reappear even after syncing from TMDb, until added back manually.`)) return;
  const movies = rows.map((r) => ({ tmdb_id: parseInt(r.dataset.id, 10) }));
  const data = await apiCall('POST', '/api/admin/movies/online-catalog/bulk-delete', { movies });
  if (data.success) {
    showToast(`Removed ${data.removed} title(s)`, 'success');
    omLoadCatalog();
  } else {
    showToast(data.message || 'Could not remove', 'error');
  }
}

// ── Rentals (grant/revoke/lookup) ────────────────────────────────────────
let omRentalsAll = [];

async function omLoadRentals() {
  const tbody = document.getElementById('omRentalsRows');
  if (!tbody) return;
  const data = await apiCall('GET', '/api/admin/movies/online-rentals');
  omRentalsAll = data.success ? data.rentals : [];
  omRenderRentals(omRentalsAll);
}

function omRenderRentals(list) {
  const tbody = document.getElementById('omRentalsRows');
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:20px;">No rentals yet.</td></tr>';
    return;
  }
  tbody.innerHTML = list.map((r) => `
    <tr data-rental-id="${r.id}">
      <td>${escapeHtml(r.title)}</td>
      <td>${escapeHtml(r.mac_address)}</td>
      <td>${new Date(r.rented_at.replace(' ', 'T') + 'Z').toLocaleString()}</td>
      <td>${r.permanent ? '<b>Permanent</b>' : new Date(r.expires_at.replace(' ', 'T') + 'Z').toLocaleString()}</td>
      <td style="text-align:right;">
        <button class="btn btn-secondary om-rental-revoke-btn" style="padding:4px 8px;font-size:11px;" title="Revoke"><i class="fas fa-xmark"></i></button>
      </td>
    </tr>
  `).join('');
}

let omRentalsFilterDebounce = null;
function omFilterRentals(value) {
  clearTimeout(omRentalsFilterDebounce);
  omRentalsFilterDebounce = setTimeout(() => {
    const q = value.trim().toLowerCase();
    const filtered = q
      ? omRentalsAll.filter((r) => r.mac_address.toLowerCase().includes(q) || r.title.toLowerCase().includes(q))
      : omRentalsAll;
    omRenderRentals(filtered);
  }, 300);
}

async function omGrantRental() {
  const mac = document.getElementById('omGrantMac').value.trim();
  const tmdb_id = parseInt(document.getElementById('omGrantTmdbId').value, 10);
  const permanent = document.getElementById('omGrantPermanent').checked;
  const hours = document.getElementById('omGrantHours').value;
  if (!mac || !tmdb_id) {
    showToast('A device MAC and a TMDb ID are required', 'error');
    return;
  }
  const data = await apiCall('POST', '/api/admin/movies/online-rentals/grant', { mac, tmdb_id, permanent, hours });
  if (data.success) {
    showToast(permanent ? 'Permanent access granted' : `Granted for ${hours} hour(s)`, 'success');
    document.getElementById('omGrantMac').value = '';
    document.getElementById('omGrantTmdbId').value = '';
    omLoadRentals();
  } else {
    showToast(data.message || 'Could not grant access', 'error');
  }
}

async function omRevokeRental(id) {
  if (!confirm('Revoke this access grant? The device will need to pay again to watch this title.')) return;
  await apiCall('DELETE', `/api/admin/movies/online-rentals/${id}`);
  showToast('Revoked', 'success');
  omLoadRentals();
}

// ── Top Searches ──────────────────────────────────────────────────────────
async function omLoadTopSearches() {
  const tbody = document.getElementById('omTopSearchesRows');
  if (!tbody) return;
  const data = await apiCall('GET', '/api/admin/movies/top-searches');
  const rows = data.success ? data.searches : [];
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:20px;">No searches logged yet.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.query)}</td>
      <td style="text-align:right;">${r.hits}</td>
      <td>${new Date(r.last_searched.replace(' ', 'T') + 'Z').toLocaleString()}</td>
    </tr>
  `).join('');
}

function omChangePage(delta) {
  const maxPage = Math.max(1, Math.ceil(omState.total / omState.limit));
  const next = omState.page + delta;
  if (next < 1 || next > maxPage) return;
  omState.page = next;
  omLoadCatalog();
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#omSearchInput') && !e.target.closest('#omSearchDropdown')) {
    const dd = document.getElementById('omSearchDropdown');
    if (dd) dd.classList.remove('show');
  }
});

// Delegated listeners (survive the table/dropdown being re-rendered on
// every reload, unlike listeners attached directly to rows that would need
// re-binding each time) - see the "no inline onclick with titles" comment
// on omRenderCatalogRow above for why these read data-id/data-title
// instead of taking arguments baked into the HTML string.
document.addEventListener('click', (e) => {
  const searchResult = e.target.closest('#omSearchDropdown .om-search-result');
  if (searchResult && searchResult.dataset.id) {
    omAddFromSearch(parseInt(searchResult.dataset.id, 10), searchResult.dataset.title);
    return;
  }
  const resetBtn = e.target.closest('.om-reset-btn');
  if (resetBtn) {
    const row = resetBtn.closest('tr');
    if (row) omResetToFree(parseInt(row.dataset.id, 10));
    return;
  }
  const deleteBtn = e.target.closest('.om-delete-btn');
  if (deleteBtn) {
    const row = deleteBtn.closest('tr');
    if (row) omDeleteFromCatalog(parseInt(row.dataset.id, 10), row.dataset.title);
    return;
  }
  const star = e.target.closest('.om-default-star');
  if (star) {
    const row = star.closest('tr[data-source-id]');
    if (row) omSetDefaultSource(row);
    return;
  }
  const removeSourceBtn = e.target.closest('.om-source-remove');
  if (removeSourceBtn) {
    const row = removeSourceBtn.closest('tr[data-source-id]');
    if (row) omRemoveSource(row);
    return;
  }
  const revokeBtn = e.target.closest('.om-rental-revoke-btn');
  if (revokeBtn) {
    const row = revokeBtn.closest('tr[data-rental-id]');
    if (row) omRevokeRental(parseInt(row.dataset.rentalId, 10));
  }
});

document.addEventListener('change', (e) => {
  if (e.target.matches('.om-tier-select, .om-price-input, .om-priority-input, .om-rental-hours-input')) {
    const row = e.target.closest('#omCatalogRows tr');
    if (row) omInlineSave(row);
  }
  if (e.target.matches('.om-source-name, .om-source-url')) {
    const row = e.target.closest('tr[data-source-id]');
    if (row) omSaveSourceRow(row);
  }
});
