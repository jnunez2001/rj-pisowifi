// ===== TV SHOWS (series/anime/K-drama) =====
// Mirrors public/admin/js/movies.js's Online Movies section (tv-* instead
// of om-*), against server/routes/admin.js's /tv-shows/* routes and
// server/services/tvCatalogService.js/tmdbTvService.js - see database.js's
// header comment on the tv_series_* tables for why this is a separate
// system rather than a flag on the movie one. Lives inside the same
// Movies page (loadMoviesPage() calls tvInit() if this file is loaded,
// destroyMovies() calls destroyTv()) rather than a separate nav tab, per
// owner request to keep everything movie/show-related in one place.

const tvState = { page: 1, limit: 30, filter: '', sort: 'title', dir: 'asc', total: 0 };
let tvSearchDebounce = null;
let tvFilterDebounce = null;
let tvRentalsFilterDebounce = null;

async function tvInit() {
  try {
    const data = await apiCall('GET', '/api/admin/tv-shows/online-settings');
    if (data.success) {
      tvSetPill('tvTmdbStatus', data.tmdb_key_set);
      tvRenderFeedStatus(data.feed);
    }
  } catch (e) {}
  tvState.page = 1;
  tvRenderSortHeaders();
  await tvLoadCatalog();
  await tvLoadRentals();
  await tvLoadTopSearches();
  await tvLoadRequests();
}

function destroyTv() {
  clearTimeout(tvSearchDebounce);
  clearTimeout(tvFilterDebounce);
  clearTimeout(tvRentalsFilterDebounce);
}

function tvSetPill(elId, isSet) {
  const pill = document.getElementById(elId);
  if (!pill) return;
  pill.textContent = isSet ? 'CONFIGURED' : 'NOT SET';
  pill.className = 'om-status-pill' + (isSet ? ' set' : '');
}

function tvRenderFeedStatus(feed) {
  const el = document.getElementById('tvFeedStatus');
  if (!el) return;
  if (!feed || !feed.count) { el.textContent = 'Not synced yet.'; return; }
  const when = feed.last_synced ? new Date(feed.last_synced.replace(' ', 'T') + 'Z').toLocaleString() : 'unknown';
  el.textContent = `${feed.count} titles synced · last run ${when}`;
}

async function tvSyncFeed() {
  const btn = document.getElementById('tvSyncBtn');
  if (btn) btn.disabled = true;
  try {
    const data = await apiCall('POST', '/api/admin/tv-shows/tmdb-sync');
    if (data.success) {
      showToast(`Synced ${data.total} title(s) from TMDb`, 'success');
      const settingsData = await apiCall('GET', '/api/admin/tv-shows/online-settings');
      if (settingsData.success) tvRenderFeedStatus(settingsData.feed);
      tvLoadCatalog();
    } else {
      showToast(data.message || 'Sync failed', 'error');
    }
  } catch (e) {
    showToast('Server error during sync', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Streaming sources are managed from the combined Streaming Sources card
// under Online Movies (public/admin/js/movies.js's om* functions) - see
// server/routes/admin.js's /movies/streaming-sources routes and the
// streaming_sources table (movie_url_template/tv_url_template columns).

// ── TMDb search / add ────────────────────────────────────────────────────
function tvSearchTmdb(value) {
  clearTimeout(tvSearchDebounce);
  const dd = document.getElementById('tvSearchDropdown');
  if (!value.trim()) { dd.classList.remove('show'); return; }
  tvSearchDebounce = setTimeout(async () => {
    const data = await apiCall('GET', `/api/admin/tv-shows/tmdb-search?q=${encodeURIComponent(value)}`);
    const results = data.success ? data.results : [];
    if (results.length === 0) {
      dd.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:12.5px;">No results.</div>';
    } else {
      dd.innerHTML = results.map((r) => `
        <div class="om-search-result" data-id="${r.id}" data-title="${escapeHtml(r.title).replace(/"/g, '&quot;')}">
          ${r.poster_path ? `<img src="https://image.tmdb.org/t/p/w92${r.poster_path}">` : '<img>'}
          <span>${escapeHtml(r.title)}</span>
          <span class="yr">${r.year || ''}</span>
        </div>
      `).join('');
    }
    dd.classList.add('show');
  }, 350);
}

async function tvAddFromSearch(tmdbId, title) {
  document.getElementById('tvSearchDropdown').classList.remove('show');
  document.getElementById('tvSearchInput').value = '';
  const data = await apiCall('POST', '/api/admin/tv-shows/catalog/price', { tmdb_id: tmdbId, title, tier: 'free', price_pesos: 0 });
  if (data.success) {
    showToast(`Added "${title}" (Free by default)`, 'success');
    document.getElementById('tvCatalogFilter').value = title;
    tvState.filter = title;
    tvState.page = 1;
    await tvLoadCatalog();
  } else {
    showToast(data.message || 'Could not add', 'error');
  }
}

async function tvAddById() {
  const tmdbId = parseInt(document.getElementById('tvAddByIdInput').value, 10);
  if (!tmdbId) { showToast('Enter a TMDb ID first', 'error'); return; }
  const data = await apiCall('POST', '/api/admin/tv-shows/catalog/add-by-id', { tmdb_id: tmdbId });
  if (data.success) {
    document.getElementById('tvAddByIdInput').value = '';
    showToast(`Added "${data.title}" (Free by default)`, 'success');
    tvLoadCatalog();
  } else {
    showToast(data.message || 'Could not add that ID', 'error');
  }
}

async function tvImportIds(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/admin/tv-shows/catalog/import', { method: 'POST', headers: { password: authToken }, body: formData });
    const data = await res.json();
    if (data.success) {
      showToast(`Imported ${data.added} title(s)${data.failed ? `, ${data.failed} failed` : ''}`, 'success');
      tvLoadCatalog();
    } else {
      showToast(data.message || 'Import failed', 'error');
    }
  } catch (e) {
    showToast('Server error during import', 'error');
  }
  document.getElementById('tvImportFile').value = '';
}

async function tvExportIds() {
  try {
    const res = await fetch('/api/admin/tv-shows/catalog/export', { headers: { password: authToken } });
    if (!res.ok) { showToast('Export failed', 'error'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tv-shows-tmdb-ids.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast('Server error during export', 'error');
  }
}

function tvFilterCatalog(value) {
  clearTimeout(tvFilterDebounce);
  tvFilterDebounce = setTimeout(() => {
    tvState.filter = value.trim();
    tvState.page = 1;
    tvLoadCatalog();
  }, 350);
}

function tvSortBy(field) {
  if (tvState.sort === field) {
    tvState.dir = tvState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    tvState.sort = field;
    tvState.dir = 'asc';
  }
  tvState.page = 1;
  tvRenderSortHeaders();
  tvLoadCatalog();
}

function tvRenderSortHeaders() {
  document.querySelectorAll('.tv-sortable').forEach((th) => {
    const active = th.dataset.sort === tvState.sort;
    th.classList.toggle('om-sort-active', active);
    th.classList.toggle('om-sort-desc', active && tvState.dir === 'desc');
  });
}

async function tvLoadCatalog() {
  const tbody = document.getElementById('tvCatalogRows');
  if (!tbody) return;
  const params = new URLSearchParams({ q: tvState.filter, sort: tvState.sort, dir: tvState.dir, page: tvState.page, limit: tvState.limit });
  const data = await apiCall('GET', `/api/admin/tv-shows/catalog?${params.toString()}`);
  if (!data.success) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:20px;">Could not load catalog</td></tr>';
    return;
  }
  tvState.total = data.total;
  if (data.series.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:20px;">No titles match.</td></tr>';
  } else {
    tbody.innerHTML = data.series.map(tvRenderCatalogRow).join('');
  }
  document.getElementById('tvSelectAll').checked = false;
  tvUpdateBulkBar();
  const start = data.total === 0 ? 0 : (tvState.page - 1) * tvState.limit + 1;
  const end = Math.min(tvState.page * tvState.limit, data.total);
  document.getElementById('tvTableSummary').textContent = `${start}-${end} of ${data.total} titles`;
}

function tvRenderCatalogRow(s) {
  const poster = s.poster ? `<img src="${s.poster}">` : '<img>';
  const priceInputStyle = s.tier === 'paid' ? '' : 'display:none;';
  const titleAttr = escapeHtml(s.title).replace(/"/g, '&quot;');
  return `
    <tr data-id="${s.id}" data-title="${titleAttr}">
      <td><input type="checkbox" class="tv-row-check" onclick="tvUpdateBulkBar()"></td>
      <td>
        <div class="om-movie-cell">
          ${poster}
          <div><div>${escapeHtml(s.title)}</div><div class="om-movie-id">tmdb ${s.id}</div></div>
        </div>
      </td>
      <td>
        <select class="tv-tier-select">
          <option value="free" ${s.tier === 'free' ? 'selected' : ''}>Free</option>
          <option value="paid" ${s.tier === 'paid' ? 'selected' : ''}>Paid</option>
        </select>
      </td>
      <td class="om-price-cell">
        <input type="number" class="tv-price-input" min="0" value="${s.price_pesos || 0}" style="width:60px;text-align:right;${priceInputStyle}">
      </td>
      <td class="om-price-cell">
        <input type="number" class="tv-priority-input" value="${s.priority || 0}" style="width:60px;text-align:right;" title="Higher shows first in genre/Anime/K-Drama rows">
      </td>
      <td class="om-price-cell">
        <input type="number" class="tv-rental-hours-input" min="0" value="${s.rental_hours || 0}" style="width:70px;text-align:right;${priceInputStyle}" title="0 = use the global default. Unlocks the WHOLE series.">
      </td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="btn btn-secondary tv-reset-btn" style="padding:4px 8px;font-size:11px;" title="Reset to Free"><i class="fas fa-rotate-left"></i></button>
        <button class="btn btn-secondary tv-delete-btn" style="padding:4px 8px;font-size:11px;color:var(--danger,#e74c3c);" title="Remove from catalog"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `;
}

function tvInlineSave(row) {
  const tmdbId = parseInt(row.dataset.id, 10);
  const title = row.dataset.title;
  const tier = row.querySelector('.tv-tier-select').value;
  const priceInput = row.querySelector('.tv-price-input');
  const rentalHoursInput = row.querySelector('.tv-rental-hours-input');
  const priority = row.querySelector('.tv-priority-input').value;
  priceInput.style.display = tier === 'paid' ? 'inline-block' : 'none';
  rentalHoursInput.style.display = tier === 'paid' ? 'inline-block' : 'none';
  tvSavePrice(tmdbId, title, tier, priceInput.value, priority, rentalHoursInput.value);
}

async function tvSavePrice(tmdbId, title, tier, priceRaw, priorityRaw, rentalHoursRaw) {
  const price_pesos = tier === 'paid' ? Math.max(0, parseInt(priceRaw, 10) || 0) : 0;
  const priority = parseInt(priorityRaw, 10) || 0;
  const rental_hours = tier === 'paid' ? Math.max(0, parseInt(rentalHoursRaw, 10) || 0) : 0;
  const data = await apiCall('POST', '/api/admin/tv-shows/catalog/price', { tmdb_id: tmdbId, title, tier, price_pesos, priority, rental_hours });
  if (data.success) showToast(`"${title}" updated`, 'success');
  else showToast(data.message || 'Could not save', 'error');
}

async function tvResetToFree(tmdbId) {
  await apiCall('DELETE', `/api/admin/tv-shows/catalog/price/${tmdbId}`);
  showToast('Reset to Free', 'success');
  tvLoadCatalog();
}

async function tvDeleteFromCatalog(tmdbId, title) {
  if (!confirm(`Remove "${title}" from the TV Shows catalog? It won't reappear even after syncing from TMDb, until it's added back manually.`)) return;
  const data = await apiCall('DELETE', `/api/admin/tv-shows/catalog/${tmdbId}`);
  if (data.success) {
    showToast(`"${title}" removed`, 'success');
    tvLoadCatalog();
  } else {
    showToast(data.message || 'Could not remove', 'error');
  }
}

function tvToggleAll(cb) {
  document.querySelectorAll('.tv-row-check').forEach((c) => c.checked = cb.checked);
  tvUpdateBulkBar();
}

function tvUpdateBulkBar() {
  const n = document.querySelectorAll('.tv-row-check:checked').length;
  document.getElementById('tvBulkCount').textContent = n;
  document.getElementById('tvBulkBar').classList.toggle('show', n > 0);
}

async function tvApplyBulk() {
  const rows = [...document.querySelectorAll('.tv-row-check:checked')].map((cb) => cb.closest('tr'));
  const series = rows.map((r) => ({ tmdb_id: parseInt(r.dataset.id, 10), title: r.dataset.title }));
  const tier = document.getElementById('tvBulkTier').value;
  const price_pesos = document.getElementById('tvBulkPrice').value;
  const data = await apiCall('POST', '/api/admin/tv-shows/catalog/bulk-price', { series, tier, price_pesos });
  if (data.success) {
    showToast(`Updated ${data.updated} title(s)`, 'success');
    tvLoadCatalog();
  } else {
    showToast(data.message || 'Could not apply', 'error');
  }
}

async function tvApplyBulkDelete() {
  const rows = [...document.querySelectorAll('.tv-row-check:checked')].map((cb) => cb.closest('tr'));
  if (rows.length === 0) return;
  if (!confirm(`Remove ${rows.length} selected title(s) from the catalog? They won't reappear even after syncing from TMDb, until added back manually.`)) return;
  const series = rows.map((r) => ({ tmdb_id: parseInt(r.dataset.id, 10) }));
  const data = await apiCall('POST', '/api/admin/tv-shows/catalog/bulk-delete', { series });
  if (data.success) {
    showToast(`Removed ${data.removed} title(s)`, 'success');
    tvLoadCatalog();
  } else {
    showToast(data.message || 'Could not remove', 'error');
  }
}

function tvChangePage(delta) {
  const maxPage = Math.max(1, Math.ceil(tvState.total / tvState.limit));
  const next = tvState.page + delta;
  if (next < 1 || next > maxPage) return;
  tvState.page = next;
  tvLoadCatalog();
}

// ── Rentals (grant/revoke/lookup) - unlocks the WHOLE series ─────────────
let tvRentalsAll = [];

async function tvLoadRentals() {
  const tbody = document.getElementById('tvRentalsRows');
  if (!tbody) return;
  const data = await apiCall('GET', '/api/admin/tv-shows/rentals');
  tvRentalsAll = data.success ? data.rentals : [];
  tvRenderRentals(tvRentalsAll);
}

function tvRenderRentals(list) {
  const tbody = document.getElementById('tvRentalsRows');
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:20px;">No rentals yet.</td></tr>';
    return;
  }
  tbody.innerHTML = list.map((r) => `
    <tr data-rental-id="${r.id}">
      <td>${escapeHtml(r.title)}</td>
      <td>${escapeHtml(r.mac_address)}</td>
      <td>${new Date(r.rented_at.replace(' ', 'T') + 'Z').toLocaleString()}</td>
      <td>${r.permanent ? '<b>Permanent</b>' : new Date(r.expires_at).toLocaleString()}</td>
      <td style="text-align:right;">
        <button class="btn btn-secondary tv-rental-revoke-btn" style="padding:4px 8px;font-size:11px;" title="Revoke"><i class="fas fa-xmark"></i></button>
      </td>
    </tr>
  `).join('');
}

function tvFilterRentals(value) {
  clearTimeout(tvRentalsFilterDebounce);
  tvRentalsFilterDebounce = setTimeout(() => {
    const q = value.trim().toLowerCase();
    const filtered = q
      ? tvRentalsAll.filter((r) => r.mac_address.toLowerCase().includes(q) || r.title.toLowerCase().includes(q))
      : tvRentalsAll;
    tvRenderRentals(filtered);
  }, 300);
}

async function tvGrantRental() {
  const mac = document.getElementById('tvGrantMac').value.trim();
  const tmdb_id = parseInt(document.getElementById('tvGrantTmdbId').value, 10);
  const permanent = document.getElementById('tvGrantPermanent').checked;
  const hours = document.getElementById('tvGrantHours').value;
  if (!mac || !tmdb_id) {
    showToast('A device MAC and a TMDb ID are required', 'error');
    return;
  }
  const data = await apiCall('POST', '/api/admin/tv-shows/rentals/grant', { mac, tmdb_id, permanent, hours });
  if (data.success) {
    showToast(permanent ? 'Permanent access granted' : `Granted for ${hours} hour(s)`, 'success');
    document.getElementById('tvGrantMac').value = '';
    document.getElementById('tvGrantTmdbId').value = '';
    tvLoadRentals();
  } else {
    showToast(data.message || 'Could not grant access', 'error');
  }
}

async function tvRevokeRental(id) {
  if (!confirm('Revoke this access grant? The device will need to pay again to watch this series.')) return;
  await apiCall('DELETE', `/api/admin/tv-shows/rentals/${id}`);
  showToast('Revoked', 'success');
  tvLoadRentals();
}

// ── Top Searches / Requests (shared tables, media_type='tv') ────────────
async function tvLoadTopSearches() {
  const tbody = document.getElementById('tvTopSearchesRows');
  if (!tbody) return;
  const data = await apiCall('GET', '/api/admin/movies/top-searches?media_type=tv');
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

async function tvLoadRequests() {
  const tbody = document.getElementById('tvRequestsRows');
  if (!tbody) return;
  const status = document.getElementById('tvRequestsStatusFilter').value;
  const params = new URLSearchParams({ media_type: 'tv', ...(status ? { status } : {}) });
  const data = await apiCall('GET', `/api/admin/movies/requests?${params.toString()}`);
  const rows = data.success ? data.requests : [];
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px;">No requests match.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr data-request-id="${r.id}">
      <td>${escapeHtml(r.requester_name)}</td>
      <td>${escapeHtml(r.title)}</td>
      <td>${escapeHtml(r.year || '—')}</td>
      <td>${new Date(r.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</td>
      <td><span class="om-tier-pill ${r.status === 'added' ? 'free' : r.status === 'declined' ? 'paid' : ''}">${r.status}</span></td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="btn btn-secondary tv-request-added-btn" style="padding:4px 8px;font-size:11px;" title="Mark Added"><i class="fas fa-check"></i></button>
        <button class="btn btn-secondary tv-request-declined-btn" style="padding:4px 8px;font-size:11px;" title="Decline"><i class="fas fa-xmark"></i></button>
        <button class="btn btn-secondary tv-request-delete-btn" style="padding:4px 8px;font-size:11px;color:var(--danger,#e74c3c);" title="Delete"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `).join('');
}

async function tvSetRequestStatus(id, status) {
  await apiCall('POST', `/api/admin/tv-shows/requests/${id}/status`, { status });
  tvLoadRequests();
}

async function tvDeleteRequest(id) {
  if (!confirm('Delete this request?')) return;
  await apiCall('DELETE', `/api/admin/tv-shows/requests/${id}`);
  tvLoadRequests();
}

// ── Delegated listeners ───────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  if (!e.target.closest('#tvSearchInput') && !e.target.closest('#tvSearchDropdown')) {
    const dd = document.getElementById('tvSearchDropdown');
    if (dd) dd.classList.remove('show');
  }
});

document.addEventListener('click', (e) => {
  const searchResult = e.target.closest('#tvSearchDropdown .om-search-result');
  if (searchResult && searchResult.dataset.id) {
    tvAddFromSearch(parseInt(searchResult.dataset.id, 10), searchResult.dataset.title);
    return;
  }
  const resetBtn = e.target.closest('.tv-reset-btn');
  if (resetBtn) {
    const row = resetBtn.closest('tr');
    if (row) tvResetToFree(parseInt(row.dataset.id, 10));
    return;
  }
  const deleteBtn = e.target.closest('.tv-delete-btn');
  if (deleteBtn) {
    const row = deleteBtn.closest('tr');
    if (row) tvDeleteFromCatalog(parseInt(row.dataset.id, 10), row.dataset.title);
    return;
  }
  const revokeBtn = e.target.closest('.tv-rental-revoke-btn');
  if (revokeBtn) {
    const row = revokeBtn.closest('tr[data-rental-id]');
    if (row) tvRevokeRental(parseInt(row.dataset.rentalId, 10));
    return;
  }
  const requestAddedBtn = e.target.closest('.tv-request-added-btn');
  if (requestAddedBtn) {
    const row = requestAddedBtn.closest('tr[data-request-id]');
    if (row) tvSetRequestStatus(parseInt(row.dataset.requestId, 10), 'added');
    return;
  }
  const requestDeclinedBtn = e.target.closest('.tv-request-declined-btn');
  if (requestDeclinedBtn) {
    const row = requestDeclinedBtn.closest('tr[data-request-id]');
    if (row) tvSetRequestStatus(parseInt(row.dataset.requestId, 10), 'declined');
    return;
  }
  const requestDeleteBtn = e.target.closest('.tv-request-delete-btn');
  if (requestDeleteBtn) {
    const row = requestDeleteBtn.closest('tr[data-request-id]');
    if (row) tvDeleteRequest(parseInt(row.dataset.requestId, 10));
  }
});

document.addEventListener('change', (e) => {
  if (e.target.matches('.tv-tier-select, .tv-price-input, .tv-priority-input, .tv-rental-hours-input')) {
    const row = e.target.closest('#tvCatalogRows tr');
    if (row) tvInlineSave(row);
  }
});
