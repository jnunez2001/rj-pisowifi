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

async function uploadPromoImage() {
  const fileInput = document.getElementById('promoFile');
  const file = fileInput.files[0];
  if (!file) {
    showToast('Please select an image first', 'error');
    return;
  }
  const formData = new FormData();
  formData.append('image', file);
  try {
    const res = await fetch('/api/admin/upload/promo', {
      method: 'POST',
      headers: { 'password': authToken },
      body: formData
    });
    const data = await res.json();
    if (data.success) {
      showToast('Added to carousel', 'success');
      fileInput.value = '';
      loadPromoImages();
    } else {
      showToast(data.message || 'Upload failed', 'error');
    }
  } catch (e) {
    showToast('Upload error', 'error');
  }
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