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
        (settings.settings.cafe_name || 'R&J PISOWIFI').toUpperCase();
      document.getElementById('previewTagline').textContent =
        settings.settings.banner_text || 'HIGH SPEED CONNECTION!';
    }
  } catch(e) {
    console.error('Branding error:', e);
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