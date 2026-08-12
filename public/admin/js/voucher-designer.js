// ===== VOUCHER DESIGNER (v1 scope) =====
// Real drag/resize canvas editor + real template persistence + real
// print output (actual voucher codes, real QR pointing at this box's
// own portal with ?code=<real code>, auto-redeemed there - see
// portal.js's tryAutoRedeemFromQr()). Deliberately NOT built in this
// pass, per explicit scoping: undo/redo history, layers panel,
// multi-select/alignment tools, shapes, image crop, QR mode switching,
// template versioning, autosave. Adding a new element is click-to-add
// from the palette (not native drag-from-panel) - simpler and more
// reliable than cross-panel HTML5 drag-and-drop; repositioning an
// element already on the canvas IS real pointer-drag.

const VT_PX_PER_IN = 100; // on-screen canvas scale only - print uses real inches
let vtTemplates = [];
let vtCurrent = null; // { id, name, description, width_in, height_in, background_color, elements: [...] }
let vtSelectedId = null;
let vtDrag = null; // { id, mode: 'move'|'resize', startX, startY, origX, origY, origW, origH }

const VT_FIELD_LABELS = {
  text: 'Text', logo: 'Logo', voucher_code: 'Voucher Code', qr_code: 'QR Code',
  price: 'Price', duration: 'Duration', plan_name: 'Plan Name', ssid: 'SSID',
};
const VT_FIELD_DEFAULTS = {
  text: { content: 'Double-click to edit', fontSize: 14, fontWeight: '400' },
  logo: { content: '', fontSize: 0, fontWeight: '400' },
  voucher_code: { content: 'SAMPLE-CODE', fontSize: 20, fontWeight: '900' },
  qr_code: { content: '', fontSize: 0, fontWeight: '400' },
  price: { content: '₱10', fontSize: 14, fontWeight: '600' },
  duration: { content: '30 Minutes', fontSize: 14, fontWeight: '600' },
  plan_name: { content: 'Standard', fontSize: 14, fontWeight: '600' },
  ssid: { content: 'ZenFi WiFi', fontSize: 12, fontWeight: '600' },
};

async function vtLoadGallery() {
  document.getElementById('vtGalleryView').style.display = 'block';
  document.getElementById('vtEditorView').style.display = 'none';
  const grid = document.getElementById('vtGalleryGrid');
  try {
    const data = await apiCall('GET', '/api/admin/voucher-templates');
    if (!data.success) { grid.innerHTML = '<div style="color:var(--text-muted);">Failed to load templates</div>'; return; }
    vtTemplates = data.templates;
    grid.innerHTML = data.templates.map((t) => `
      <div class="zf3-card" style="cursor:pointer;" onclick="vtOpenTemplate(${t.id})">
        <div style="width:100%;aspect-ratio:${t.width_in}/${t.height_in};background:${t.background_color};border:1px solid var(--border-color);border-radius:6px;margin-bottom:10px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:11px;">
          ${t.width_in}" × ${t.height_in}"
        </div>
        <div style="font-size:13px;font-weight:700;color:var(--text-primary);">${t.name} ${t.is_system ? '<span class="badge badge-blue" style="margin-left:4px;">System</span>' : ''}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${t.description || ''}</div>
        ${!t.is_system ? `<button class="btn btn-sm btn-danger" style="margin-top:10px;" onclick="event.stopPropagation();vtDeleteTemplate(${t.id})"><i class="fas fa-trash"></i></button>` : ''}
      </div>
    `).join('') + `
      <div class="zf3-card" style="cursor:pointer;border-style:dashed;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:160px;" onclick="vtStartBlank()">
        <i class="fas fa-plus" style="font-size:20px;color:var(--text-muted);margin-bottom:8px;"></i>
        <div style="font-size:13px;font-weight:600;color:var(--text-primary);">Start Blank</div>
      </div>
    `;
  } catch (e) {
    grid.innerHTML = '<div style="color:var(--text-muted);">Failed to load templates</div>';
  }
}

function vtBackToGallery() {
  vtCurrent = null;
  vtSelectedId = null;
  vtLoadGallery();
}

async function vtOpenTemplate(id) {
  try {
    const data = await apiCall('GET', `/api/admin/voucher-templates/${id}`);
    if (!data.success) { showToast(data.message || 'Failed to load template', 'error'); return; }
    vtCurrent = {
      id: data.template.is_system ? null : data.template.id, // system templates always "Save as New"
      sourceId: data.template.id,
      isSystem: !!data.template.is_system,
      name: data.template.is_system ? `${data.template.name} (Copy)` : data.template.name,
      description: data.template.description,
      width_in: data.template.width_in,
      height_in: data.template.height_in,
      background_color: data.template.background_color,
      elements: data.template.elements,
    };
    vtOpenEditor();
  } catch (e) {
    showToast('Server error', 'error');
  }
}

function vtStartBlank() {
  vtCurrent = { id: null, sourceId: null, isSystem: false, name: 'Untitled Template', description: '', width_in: 3.5, height_in: 2, background_color: '#ffffff', elements: [] };
  vtOpenEditor();
}

function vtOpenEditor() {
  document.getElementById('vtGalleryView').style.display = 'none';
  document.getElementById('vtEditorView').style.display = 'block';
  document.getElementById('vtTemplateName').value = vtCurrent.name;
  document.getElementById('vtSaveStatus').textContent = vtCurrent.isSystem ? 'Editing a copy of a system template' : '';
  vtSelectedId = null;
  vtRenderCanvas();
  vtRenderProperties();
}

function vtApplySizePreset() {
  const [w, h] = document.getElementById('vtSizePreset').value.split('x').map(Number);
  vtCurrent.width_in = w;
  vtCurrent.height_in = h;
  vtRenderCanvas();
}

function vtAddElement(type) {
  const defaults = VT_FIELD_DEFAULTS[type];
  const el = {
    id: 'el' + Date.now(),
    type,
    field: type === 'text' || type === 'logo' ? null : `voucher.${type}`,
    x: 0.2, y: 0.2, w: type === 'qr_code' || type === 'logo' ? 0.9 : 1.5, h: type === 'qr_code' || type === 'logo' ? 0.9 : 0.35,
    fontSize: defaults.fontSize, fontWeight: defaults.fontWeight, color: '#111827', align: 'left',
    content: defaults.content,
  };
  vtCurrent.elements.push(el);
  vtSelectedId = el.id;
  vtRenderCanvas();
  vtRenderProperties();
}

function vtRenderCanvas() {
  const canvas = document.getElementById('vtCanvas');
  canvas.style.width = (vtCurrent.width_in * VT_PX_PER_IN) + 'px';
  canvas.style.height = (vtCurrent.height_in * VT_PX_PER_IN) + 'px';
  canvas.style.background = vtCurrent.background_color || '#fff';
  canvas.innerHTML = '';
  vtCurrent.elements.forEach((el) => {
    const div = document.createElement('div');
    div.className = 'vt-el';
    div.dataset.id = el.id;
    div.style.cssText = `position:absolute;left:${el.x * VT_PX_PER_IN}px;top:${el.y * VT_PX_PER_IN}px;width:${el.w * VT_PX_PER_IN}px;height:${el.h * VT_PX_PER_IN}px;
      display:flex;align-items:center;justify-content:${el.align === 'center' ? 'center' : el.align === 'right' ? 'flex-end' : 'flex-start'};
      font-size:${el.fontSize}px;font-weight:${el.fontWeight};color:${el.color};cursor:move;overflow:hidden;
      outline:${el.id === vtSelectedId ? '2px solid #2563eb' : '1px dashed rgba(0,0,0,0.15)'};user-select:none;`;

    if (el.type === 'qr_code') {
      div.style.background = '#fff';
      const qrHolder = document.createElement('div');
      div.appendChild(qrHolder);
      if (window.QRCode) new QRCode(qrHolder, { text: `${window.location.origin}/portal?code=SAMPLE`, width: el.w * VT_PX_PER_IN, height: el.h * VT_PX_PER_IN, correctLevel: QRCode.CorrectLevel.M });
    } else if (el.type === 'logo') {
      div.style.justifyContent = 'center';
      div.innerHTML = el.content ? `<img src="${el.content}" style="max-width:100%;max-height:100%;object-fit:contain;">` : '<i class="fas fa-image" style="color:var(--text-muted);"></i>';
    } else {
      div.textContent = el.content;
    }

    div.addEventListener('mousedown', (e) => vtStartDrag(e, el.id, 'move'));
    canvas.appendChild(div);

    if (el.id === vtSelectedId) {
      const handle = document.createElement('div');
      handle.style.cssText = `position:absolute;left:${el.x * VT_PX_PER_IN + el.w * VT_PX_PER_IN - 8}px;top:${el.y * VT_PX_PER_IN + el.h * VT_PX_PER_IN - 8}px;width:12px;height:12px;background:#2563eb;border-radius:50%;cursor:nwse-resize;`;
      handle.addEventListener('mousedown', (e) => { e.stopPropagation(); vtStartDrag(e, el.id, 'resize'); });
      canvas.appendChild(handle);
    }
  });
  canvas.onclick = (e) => { if (e.target === canvas) { vtSelectedId = null; vtRenderCanvas(); vtRenderProperties(); } };
}

function vtStartDrag(e, id, mode) {
  e.preventDefault();
  vtSelectedId = id;
  const el = vtCurrent.elements.find((x) => x.id === id);
  vtDrag = { id, mode, startX: e.clientX, startY: e.clientY, origX: el.x, origY: el.y, origW: el.w, origH: el.h };
  document.addEventListener('mousemove', vtOnDrag);
  document.addEventListener('mouseup', vtEndDrag);
  vtRenderCanvas();
  vtRenderProperties();
}

function vtOnDrag(e) {
  if (!vtDrag) return;
  const el = vtCurrent.elements.find((x) => x.id === vtDrag.id);
  const dx = (e.clientX - vtDrag.startX) / VT_PX_PER_IN;
  const dy = (e.clientY - vtDrag.startY) / VT_PX_PER_IN;
  if (vtDrag.mode === 'move') {
    el.x = Math.max(0, Math.min(vtCurrent.width_in - el.w, vtDrag.origX + dx));
    el.y = Math.max(0, Math.min(vtCurrent.height_in - el.h, vtDrag.origY + dy));
  } else {
    el.w = Math.max(0.2, Math.min(vtCurrent.width_in - el.x, vtDrag.origW + dx));
    el.h = Math.max(0.15, Math.min(vtCurrent.height_in - el.y, vtDrag.origH + dy));
  }
  vtRenderCanvas();
}

function vtEndDrag() {
  vtDrag = null;
  document.removeEventListener('mousemove', vtOnDrag);
  document.removeEventListener('mouseup', vtEndDrag);
  vtRenderProperties();
}

function vtRenderProperties() {
  const panel = document.getElementById('vtPropertiesPanel');
  const el = vtCurrent.elements.find((x) => x.id === vtSelectedId);
  if (!el) { panel.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">Select an element to edit it.</div>'; return; }

  const isTextLike = ['text', 'voucher_code', 'price', 'duration', 'plan_name', 'ssid'].includes(el.type);
  panel.innerHTML = `
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">${VT_FIELD_LABELS[el.type]}</div>
    ${el.type === 'text' ? `<div class="form-group"><label class="form-label">Text</label><input type="text" class="form-control" value="${el.content.replace(/"/g, '&quot;')}" oninput="vtUpdateProp('content', this.value)"></div>` : ''}
    ${el.type === 'logo' ? `<div class="form-group"><label class="form-label">Image URL</label><input type="text" class="form-control" placeholder="https://..." value="${el.content}" oninput="vtUpdateProp('content', this.value)"></div>` : ''}
    ${isTextLike ? `
      <div class="form-row">
        <div class="form-group"><label class="form-label">Font Size</label><input type="number" class="form-control" value="${el.fontSize}" oninput="vtUpdateProp('fontSize', parseInt(this.value)||14)"></div>
        <div class="form-group"><label class="form-label">Weight</label>
          <select class="form-control" onchange="vtUpdateProp('fontWeight', this.value)">
            <option value="400" ${el.fontWeight === '400' ? 'selected' : ''}>Normal</option>
            <option value="600" ${el.fontWeight === '600' ? 'selected' : ''}>Semibold</option>
            <option value="900" ${el.fontWeight === '900' ? 'selected' : ''}>Bold</option>
          </select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Color</label><input type="color" class="form-control" value="${el.color}" oninput="vtUpdateProp('color', this.value)" style="height:36px;"></div>
      <div class="form-group"><label class="form-label">Align</label>
        <select class="form-control" onchange="vtUpdateProp('align', this.value)">
          <option value="left" ${el.align === 'left' ? 'selected' : ''}>Left</option>
          <option value="center" ${el.align === 'center' ? 'selected' : ''}>Center</option>
          <option value="right" ${el.align === 'right' ? 'selected' : ''}>Right</option>
        </select>
      </div>
    ` : ''}
    <div class="card-title" style="font-size:11px;margin:12px 0 6px;color:var(--text-muted);">POSITION &amp; SIZE (in)</div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">X</label><input type="number" step="0.05" class="form-control" value="${el.x.toFixed(2)}" oninput="vtUpdateProp('x', parseFloat(this.value)||0)"></div>
      <div class="form-group"><label class="form-label">Y</label><input type="number" step="0.05" class="form-control" value="${el.y.toFixed(2)}" oninput="vtUpdateProp('y', parseFloat(this.value)||0)"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">W</label><input type="number" step="0.05" class="form-control" value="${el.w.toFixed(2)}" oninput="vtUpdateProp('w', parseFloat(this.value)||0.2)"></div>
      <div class="form-group"><label class="form-label">H</label><input type="number" step="0.05" class="form-control" value="${el.h.toFixed(2)}" oninput="vtUpdateProp('h', parseFloat(this.value)||0.15)"></div>
    </div>
    <button class="btn btn-sm btn-danger" style="width:100%;margin-top:8px;" onclick="vtDeleteElement()"><i class="fas fa-trash"></i> Delete Element</button>
  `;
}

function vtUpdateProp(key, value) {
  const el = vtCurrent.elements.find((x) => x.id === vtSelectedId);
  if (!el) return;
  el[key] = value;
  vtRenderCanvas();
}

function vtDeleteElement() {
  vtCurrent.elements = vtCurrent.elements.filter((x) => x.id !== vtSelectedId);
  vtSelectedId = null;
  vtRenderCanvas();
  vtRenderProperties();
}

async function vtSaveTemplate(saveAsNew) {
  vtCurrent.name = document.getElementById('vtTemplateName').value.trim() || 'Untitled Template';
  const status = document.getElementById('vtSaveStatus');
  status.textContent = 'Saving...';
  try {
    const body = {
      name: vtCurrent.name, description: vtCurrent.description || '',
      width_in: vtCurrent.width_in, height_in: vtCurrent.height_in,
      background_color: vtCurrent.background_color, elements: vtCurrent.elements,
    };
    let data;
    if (vtCurrent.id && !saveAsNew) {
      data = await apiCall('PATCH', `/api/admin/voucher-templates/${vtCurrent.id}`, body);
    } else {
      data = await apiCall('POST', '/api/admin/voucher-templates', body);
      if (data.success) { vtCurrent.id = data.id; vtCurrent.isSystem = false; }
    }
    if (data.success) {
      status.textContent = 'Saved';
      showToast('Template saved', 'success');
    } else {
      status.textContent = 'Not saved';
      showToast(data.message || 'Failed to save template', 'error');
    }
  } catch (e) {
    status.textContent = 'Not saved';
    showToast('Server error', 'error');
  }
}

async function vtDeleteTemplate(id) {
  if (!confirm('Delete this template? Existing printed vouchers are not affected.')) return;
  try {
    const data = await apiCall('DELETE', `/api/admin/voucher-templates/${id}`);
    if (data.success) { showToast('Template deleted', 'success'); vtLoadGallery(); }
    else showToast(data.message || 'Failed to delete', 'error');
  } catch (e) { showToast('Server error', 'error'); }
}

// Renders one voucher's worth of the template into an HTML string,
// resolving dynamic fields from a real (or sample) voucher record.
function vtRenderVoucherHtml(voucher, group) {
  const w = vtCurrent.width_in, h = vtCurrent.height_in;
  const elsHtml = vtCurrent.elements.map((el) => {
    const posStyle = `position:absolute;left:${el.x}in;top:${el.y}in;width:${el.w}in;height:${el.h}in;display:flex;align-items:center;justify-content:${el.align === 'center' ? 'center' : el.align === 'right' ? 'flex-end' : 'flex-start'};font-size:${el.fontSize}px;font-weight:${el.fontWeight};color:${el.color};overflow:hidden;`;
    if (el.type === 'qr_code') {
      return `<div style="${posStyle}" class="vt-print-qr" data-url="${window.location.origin}/portal?code=${voucher.code}"></div>`;
    }
    if (el.type === 'logo') {
      return el.content ? `<div style="${posStyle}"><img src="${el.content}" style="max-width:100%;max-height:100%;object-fit:contain;"></div>` : '';
    }
    let text = el.content;
    if (el.type === 'voucher_code') text = voucher.code;
    else if (el.type === 'price') text = `₱${group.price}`;
    else if (el.type === 'duration') text = formatDuration(group.duration_minutes);
    else if (el.type === 'plan_name') text = group.name;
    return `<div style="${posStyle}">${text}</div>`;
  }).join('');
  return `<div class="vt-print-card" style="position:relative;width:${w}in;height:${h}in;background:${vtCurrent.background_color};border:1px dashed #999;page-break-inside:avoid;">${elsHtml}</div>`;
}

function vtPreview() {
  const sampleVoucher = { code: 'SAMPLE-CODE' };
  const sampleGroup = { price: 10, duration_minutes: 30, name: 'Sample Plan' };
  vtOpenPrintWindow([sampleVoucher], sampleGroup, true);
}

async function vtOpenPrintModal() {
  const select = document.getElementById('vtPrintGroupSelect');
  select.innerHTML = '<option value="">Select a group...</option>';
  try {
    const data = await apiCall('GET', '/api/admin/vouchers/groups');
    if (data.success) {
      data.groups.forEach((g) => {
        select.innerHTML += `<option value="${g.id}">${g.name} (${g.unused_count || 0} unused)</option>`;
      });
    }
  } catch (e) {}
  document.getElementById('vtPrintModal').classList.add('show');
}

async function vtPrintGroup() {
  const groupId = document.getElementById('vtPrintGroupSelect').value;
  if (!groupId) { showToast('Select a voucher group', 'error'); return; }
  await vtSaveTemplate(false);
  try {
    const data = await apiCall('GET', `/api/admin/vouchers/groups/${groupId}`);
    if (!data.success) { showToast(data.message || 'Failed to load group', 'error'); return; }
    closeModal('vtPrintModal');
    vtOpenPrintWindow(data.vouchers, data.group, false);
  } catch (e) {
    showToast('Server error', 'error');
  }
}

function vtOpenPrintWindow(vouchers, group, isPreview) {
  const cardsHtml = vouchers.map((v) => vtRenderVoucherHtml(v, group)).join('');
  const printWindow = window.open('', '_blank');
  if (!printWindow) { showToast('Please allow pop-ups to print vouchers', 'error'); return; }
  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>${isPreview ? 'Preview' : group.name} - Voucher Print</title>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
      <style>
        @page { size: A4; margin: 10mm; }
        body { font-family: Arial, sans-serif; margin: 0; }
        .vt-print-grid { display: flex; flex-wrap: wrap; gap: 6mm; }
        ${isPreview ? '.preview-banner { background: #fef3c7; color: #92400e; padding: 8px 16px; font-size: 13px; text-align: center; }' : ''}
      </style>
    </head>
    <body>
      ${isPreview ? '<div class="preview-banner">Preview - sample data shown, not a real voucher</div>' : ''}
      <div class="vt-print-grid">${cardsHtml}</div>
      <script>
        window.onload = () => {
          document.querySelectorAll('.vt-print-qr').forEach((el) => {
            new QRCode(el, { text: el.dataset.url, width: el.clientWidth || 80, height: el.clientHeight || 80, correctLevel: QRCode.CorrectLevel.M });
          });
          setTimeout(() => window.print(), 300);
        };
      <\/script>
    </body>
    </html>
  `);
  printWindow.document.close();
}
