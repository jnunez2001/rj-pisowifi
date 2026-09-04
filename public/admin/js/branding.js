async function loadBranding() {
  try {
    const data = await apiCall('GET', '/api/admin/assets');
    if (!data.success) return;

    if (data.logo_url) {
      const preview = document.getElementById('logoPreview');
      preview.innerHTML = `<img src="${data.logo_url}" style="width:100%;height:100%;object-fit:contain;">`;
    }

    if (data.banner_url) {
      const preview = document.getElementById('bannerPreview');
      preview.style.backgroundImage = `url(${data.banner_url})`;
      preview.style.backgroundSize = 'cover';
      preview.style.backgroundPosition = 'center';
      preview.innerHTML = '';
    }

    // Update preview
    const settings = await apiCall('GET', '/api/admin/settings');
    if (settings.success) {
      document.getElementById('previewName').textContent =
        (settings.settings.cafe_name || 'STARKFI').toUpperCase();
      document.getElementById('previewTagline').textContent =
        settings.settings.banner_text || 'HIGH SPEED CONNECTION!';
      document.getElementById('promoCarouselSpeed').value =
        settings.settings.promo_carousel_interval_seconds || '5';
    }

    await loadPromoImages();
  } catch(e) {
    console.error('Branding error:', e);
  }
}

// ===== PROMO/AD CAROUSEL =====
async function loadPromoImages() {
  const el = document.getElementById('promoImagesList');
  if (!el) return;
  const data = await apiCall('GET', '/api/admin/promo-banner-images');
  const images = data.images || [];
  if (images.length === 0) {
    el.innerHTML = '<p style="font-size:12px;color:var(--text-muted);">No promo images yet.</p>';
    return;
  }
  el.innerHTML = images.map((img, i) => `
    <div style="position:relative;width:120px;">
      <img src="${img.image_path}" style="width:120px;height:68px;object-fit:cover;border-radius:8px;border:1px solid var(--border-color);">
      <div style="display:flex;gap:4px;margin-top:4px;">
        <button class="btn btn-sm btn-secondary" style="flex:1;padding:3px;" onclick="movePromoImage(${img.id},-1)" ${i === 0 ? 'disabled' : ''}><i class="fas fa-arrow-left"></i></button>
        <button class="btn btn-sm btn-secondary" style="flex:1;padding:3px;" onclick="movePromoImage(${img.id},1)" ${i === images.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-right"></i></button>
        <button class="btn btn-sm btn-secondary" style="flex:1;padding:3px;color:var(--accent-red);" onclick="deletePromoImage(${img.id})"><i class="fas fa-trash"></i></button>
      </div>
    </div>
  `).join('');
  window._promoImagesOrder = images.map((img) => img.id);
}

// Bulk upload: the file input takes multiple selections at once (an
// operator adding a batch of new movie posters shouldn't have to repeat
// this one-at-a-time), but the upload endpoint itself is still the same
// single-file POST /api/admin/upload/promo it always was - no server
// change needed, this just loops it sequentially (one at a time, not
// Promise.all, so the carousel's sort_order comes out in the same order
// the files were selected, and one failed file doesn't abort the rest).
async function uploadPromoImage() {
  const fileInput = document.getElementById('promoFile');
  const files = Array.from(fileInput.files || []);
  if (files.length === 0) {
    showToast('Please select at least one image', 'error');
    return;
  }

  const btn = document.getElementById('promoUploadBtn');
  const originalBtnHtml = btn.innerHTML;
  btn.disabled = true;

  let succeeded = 0;
  const failed = [];

  for (let i = 0; i < files.length; i++) {
    btn.innerHTML = files.length > 1
      ? `<i class="fas fa-spinner fa-spin"></i> Uploading ${i + 1} of ${files.length}...`
      : `<i class="fas fa-spinner fa-spin"></i> Uploading...`;

    const formData = new FormData();
    formData.append('image', files[i]);
    try {
      const res = await fetch('/api/admin/upload/promo', {
        method: 'POST',
        headers: { 'password': authToken },
        body: formData
      });
      const data = await res.json().catch(() => null);
      if (data && data.success) succeeded++;
      // Real bug found live: a file over the server's 5MB limit (or a
      // rejected format) used to throw inside multer with no error
      // handling wired up for it, so the server sent back a raw HTML
      // stack-trace page instead of JSON - res.json() above threw its own
      // parse error, landing here with zero indication of what actually
      // went wrong. The server now always replies with a real
      // {success:false, message} for this (server/routes/admin.js's
      // uploadImageMiddleware), so surface that real reason instead of
      // just naming the file.
      else failed.push(`${files[i].name} (${(data && data.message) || 'upload failed'})`);
    } catch (e) {
      failed.push(`${files[i].name} (upload failed)`);
    }
  }

  btn.disabled = false;
  btn.innerHTML = originalBtnHtml;
  fileInput.value = '';

  if (failed.length === 0) {
    showToast(succeeded === 1 ? 'Added to carousel' : `Added ${succeeded} images to carousel`, 'success');
  } else if (succeeded === 0) {
    showToast(failed.length === 1 ? failed[0] : `${failed.length} images failed: ${failed.join(', ')}`, 'error');
  } else {
    showToast(`Added ${succeeded} image(s). Failed: ${failed.join(', ')}`, 'error');
  }
  loadPromoImages();
}

async function deletePromoImage(id) {
  if (!confirm('Remove this image from the carousel?')) return;
  await apiCall('DELETE', `/api/admin/promo-banner-images/${id}`);
  loadPromoImages();
}

async function movePromoImage(id, direction) {
  const ids = window._promoImagesOrder || [];
  const index = ids.indexOf(id);
  const swapWith = index + direction;
  if (index === -1 || swapWith < 0 || swapWith >= ids.length) return;
  [ids[index], ids[swapWith]] = [ids[swapWith], ids[index]];
  await apiCall('POST', '/api/admin/promo-banner-images/reorder', { ids });
  loadPromoImages();
}

async function savePromoCarouselSpeed() {
  const input = document.getElementById('promoCarouselSpeed');
  const seconds = parseInt(input.value, 10);
  if (!Number.isFinite(seconds) || seconds < 2 || seconds > 30) {
    showToast('Enter a number between 2 and 30 seconds', 'error');
    return;
  }
  try {
    const data = await apiCall('POST', '/api/admin/settings', { promo_carousel_interval_seconds: String(seconds) });
    if (data.success) showToast('Carousel speed saved', 'success');
    else showToast(data.message || 'Failed to save', 'error');
  } catch (e) {
    showToast('Server error', 'error');
  }
}

function previewImage(inputId, previewId) {
  const file = document.getElementById(inputId).files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const preview = document.getElementById(previewId);
    preview.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:contain;">`;
  };
  reader.readAsDataURL(file);
}

function previewBanner(inputId, previewId) {
  const file = document.getElementById(inputId).files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const preview = document.getElementById(previewId);
    preview.style.backgroundImage = `url(${e.target.result})`;
    preview.style.backgroundSize = 'cover';
    preview.style.backgroundPosition = 'center';
    preview.innerHTML = '';
  };
  reader.readAsDataURL(file);
}

async function uploadAsset(type) {
  const fileInput = document.getElementById(`${type}File`);
  const file = fileInput.files[0];

  if (!file) {
    showToast(`Please select a ${type} image first`, 'error');
    return;
  }

  const formData = new FormData();
  formData.append('image', file);

  try {
    const res = await fetch(`/api/admin/upload/${type}`, {
      method: 'POST',
      headers: { 'password': authToken },
      body: formData
    });
    const data = await res.json();

    if (data.success) {
      showToast(`${type} uploaded successfully!`, 'success');
      loadBranding();
    } else {
      showToast(data.message || 'Upload failed', 'error');
    }
  } catch(e) {
    showToast('Upload error', 'error');
  }
}

async function removeLogo() {
  try {
    await apiCall('POST', '/api/admin/settings', { logo_url: '' });
    document.getElementById('logoPreview').innerHTML =
      '<i class="fas fa-image"></i>';
    showToast('Logo removed', 'success');
  } catch(e) {}
}

async function removeBanner() {
  try {
    await apiCall('POST', '/api/admin/settings', { banner_url: '' });
    const preview = document.getElementById('bannerPreview');
    preview.style.backgroundImage = '';
    preview.innerHTML = 'Default Banner';
    showToast('Banner removed', 'success');
  } catch(e) {}
}