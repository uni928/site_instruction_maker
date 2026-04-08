const APP_VERSION = '1.3.4';
const DB_NAME = 'site-instruction-maker-db';
const STORE_NAME = 'kv';
const AUTOSAVE_KEY = 'autosave';

const shotImage = document.getElementById('shotImage');
const overlay = document.getElementById('overlay');
const infoList = document.getElementById('infoList');
const previewCanvas = document.getElementById('previewCanvas');
const exportBtn = document.getElementById('exportBtn');
const renderBtn = document.getElementById('renderBtn');
const deleteBtn = document.getElementById('deleteBtn');
const saveState = document.getElementById('saveState');
const captureModeNote = document.getElementById('captureModeNote');

const ctx = overlay.getContext('2d');
const previewCtx = previewCanvas.getContext('2d');

let state = null;
let dragMode = null;
let dragOffset = { x: 0, y: 0 };
let initialLineAngle = 0;
let initialPointerAngle = 0;

init();

async function init() {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') || 'resume';
  state = await loadInitialState(mode);
  if (!state) {
    alert('読み込めるデータがありません。');
    window.close();
    return;
  }
  shotImage.onload = async () => {
    resizeOverlay();
    draw();
    renderInfoList();
    await renderPreview();
  };
  shotImage.src = state.screenshot;
  setupEvents();
  updateCaptureModeNote();
  await autosave();
}

async function loadInitialState(mode) {
  if (mode === 'capture') {
    const result = await chrome.storage.local.get(['pendingCaptureState']);
    return migrateState(result.pendingCaptureState);
  }
  if (mode === 'import') {
    const result = await chrome.storage.local.get(['pendingImportedState']);
    return migrateState(result.pendingImportedState);
  }
  const saved = await idbGet(AUTOSAVE_KEY);
  return migrateState(saved);
}

function migrateState(value) {
  if (!value) return null;
  return {
    version: 4,
    createdAt: value.createdAt || new Date().toISOString(),
    updatedAt: value.updatedAt || new Date().toISOString(),
    screenshot: value.screenshot,
    originalCapture: value.originalCapture || value.screenshot,
    markers: Array.isArray(value.markers)
      ? value.markers.map(m => ({
          id: m.id,
          number: m.number,
          x: m.x,
          y: m.y,
          text: m.text || '',
          lineAngle: typeof m.lineAngle === 'number' ? m.lineAngle : -Math.PI / 4,
          lineLength: typeof m.lineLength === 'number' ? m.lineLength : 34
        }))
      : [],
    nextId: value.nextId || ((value.markers?.length || 0) + 1),
    selectedMarkerId: value.selectedMarkerId || null,
    captureMode: value.captureMode || 'visible',
    sourcePage: value.sourcePage || null
  };
}

function setupEvents() {
  window.addEventListener('resize', () => {
    resizeOverlay();
    draw();
  });

  document.addEventListener('pointerdown', onDocumentPointerDown, true);

  overlay.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('pointerup', onPointerUp);
  overlay.addEventListener('pointerleave', onPointerUp);

  document.addEventListener('keydown', onDocumentKeyDown);

  exportBtn.addEventListener('click', exportState);
  renderBtn.addEventListener('click', async () => {
    await renderPreview();
    const dataUrl = previewCanvas.toDataURL('image/png');
    await downloadDataUrl(dataUrl, `instruction-sheet-${timestamp()}-ver${APP_VERSION}.png`);
  });
  deleteBtn.addEventListener('click', deleteSelectedMarker);
}

async function onDocumentKeyDown(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    await exportState();
    return;
  }

  const activeEl = document.activeElement;
  const isTextEditingElement = activeEl && (
    activeEl.tagName === 'TEXTAREA' ||
    activeEl.tagName === 'INPUT' ||
    activeEl.isContentEditable
  );

  if (event.key === 'Delete' && !isTextEditingElement) {
    event.preventDefault();
    await deleteSelectedMarker();
    return;
  }
}

function updateCaptureModeNote() {
  if (!captureModeNote) return;
  captureModeNote.textContent = state.captureMode === 'fullpage'
    ? '現在のデータはフルページ撮影です。'
    : '現在のデータは表示範囲のみの撮影です。';
}

function resizeOverlay() {
  const rect = shotImage.getBoundingClientRect();
  overlay.width = Math.round(rect.width);
  overlay.height = Math.round(rect.height);
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
}

function onDocumentPointerDown(event) {
  if (overlay.contains(event.target)) return;
  if (event.target.closest('.info-item')) {
    if (event.target.closest('textarea, input, button, label, select')) clearSelection();
    return;
  }
  clearSelection();
}

function onPointerDown(event) {
  const point = toImagePoint(event);
  const marker = findHitMarker(point);
  if (marker?.hitType === 'rotate') {
    selectMarker(marker.marker.id);
    dragMode = 'rotate';
    initialLineAngle = marker.marker.lineAngle;
    initialPointerAngle = Math.atan2(point.y - marker.marker.y, point.x - marker.marker.x);
    overlay.setPointerCapture(event.pointerId);
    draw();
    return;
  }
  if (marker?.hitType === 'body') {
    selectMarker(marker.marker.id);
    dragMode = 'move';
    dragOffset.x = point.x - marker.marker.x;
    dragOffset.y = point.y - marker.marker.y;
    overlay.setPointerCapture(event.pointerId);
    draw();
    return;
  }
  const newMarker = createMarker(point.x, point.y);
  selectMarker(newMarker.id);
  dragMode = null;
  draw();
  renderInfoList();
  scrollInfoItemIntoView(newMarker.id);
  renderPreview();
  autosave();
}

function onPointerMove(event) {
  if (!dragMode) return;
  const point = toImagePoint(event);
  const marker = getSelectedMarker();
  if (!marker) return;
  if (dragMode === 'move') {
    marker.x = clamp(point.x - dragOffset.x, 28, imageWidth() - 28);
    marker.y = clamp(point.y - dragOffset.y, 28, imageHeight() - 28);
  } else if (dragMode === 'rotate') {
    const currentAngle = Math.atan2(point.y - marker.y, point.x - marker.x);
    marker.lineAngle = initialLineAngle + (currentAngle - initialPointerAngle);
  }
  state.updatedAt = new Date().toISOString();
  draw();
  renderPreview();
}

function onPointerUp(event) {
  if (event?.pointerId != null && overlay.hasPointerCapture(event.pointerId)) {
    overlay.releasePointerCapture(event.pointerId);
  }
  if (!dragMode) return;
  dragMode = null;
  autosave();
}

function toImagePoint(event) {
  const rect = overlay.getBoundingClientRect();
  const scaleX = imageWidth() / rect.width;
  const scaleY = imageHeight() / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY
  };
}

function imageWidth() { return shotImage.naturalWidth || 1; }
function imageHeight() { return shotImage.naturalHeight || 1; }

function createMarker(x, y) {
  const id = state.nextId++;
  const marker = {
    id,
    number: getNextNumber(),
    x,
    y,
    text: '',
    lineAngle: -Math.PI / 4,
    lineLength: 34
  };
  state.markers.push(marker);
  state.updatedAt = new Date().toISOString();
  return marker;
}

function getNextNumber() {
  const numbers = state.markers.map(m => m.number).sort((a, b) => a - b);
  let n = 1;
  for (const value of numbers) {
    if (value === n) n++;
    else if (value > n) break;
  }
  return n;
}

function findHitMarker(point) {
  const radius = 20;
  const rotateRadius = 10;
  for (const marker of [...state.markers].reverse()) {
    const dx = point.x - marker.x;
    const dy = point.y - marker.y;
    if (Math.hypot(dx, dy) <= radius) return { marker, hitType: 'body' };
    const handle = getRotateHandle(marker);
    if (Math.hypot(point.x - handle.x, point.y - handle.y) <= rotateRadius) {
      return { marker, hitType: 'rotate' };
    }
  }
  return null;
}

function getRotateHandle(marker) {
  const len = marker.lineLength + 8;
  return {
    x: marker.x + Math.cos(marker.lineAngle) * len,
    y: marker.y + Math.sin(marker.lineAngle) * len
  };
}

function selectMarker(id) {
  state.selectedMarkerId = id;
  renderInfoList();
  scrollInfoItemIntoView(id);
  draw();
}

function clearSelection() {
  if (!state.selectedMarkerId) return;
  state.selectedMarkerId = null;
  renderInfoList();
  draw();
}

function getSelectedMarker() {
  return state.markers.find(m => m.id === state.selectedMarkerId) || null;
}

function getMarkerTextarea(markerId) {
  return infoList.querySelector(`textarea[data-marker-id="${markerId}"]`);
}

async function deleteSelectedMarker() {
  const marker = getSelectedMarker();
  if (!marker) return;
  state.markers = state.markers.filter(m => m.id !== marker.id);
  renumberMarkers();
  state.selectedMarkerId = null;
  state.updatedAt = new Date().toISOString();
  draw();
  renderInfoList();
  await renderPreview();
  await autosave();
}

function renumberMarkers() {
  state.markers.sort((a, b) => a.number - b.number).forEach((marker, index) => {
    marker.number = index + 1;
  });
}

function draw() {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  drawMarkers(ctx, overlay.width / imageWidth(), overlay.height / imageHeight(), true, state.selectedMarkerId);
}

function drawMarkers(targetCtx, scaleX, scaleY, includeHandle, selectedId = null) {
  targetCtx.save();
  targetCtx.scale(scaleX, scaleY);

  for (const marker of state.markers) {
    const isSelected = marker.id === selectedId;
    const handle = getRotateHandle(marker);

    targetCtx.strokeStyle = '#e11d48';
    targetCtx.fillStyle = '#ffffff';
    targetCtx.lineWidth = 4;
    targetCtx.beginPath();
    targetCtx.moveTo(marker.x + Math.cos(marker.lineAngle) * 22, marker.y + Math.sin(marker.lineAngle) * 22);
    targetCtx.lineTo(marker.x + Math.cos(marker.lineAngle) * (marker.lineLength + 8), marker.y + Math.sin(marker.lineAngle) * (marker.lineLength + 8));
    targetCtx.stroke();

    targetCtx.beginPath();
    targetCtx.arc(marker.x, marker.y, 20, 0, Math.PI * 2);
    targetCtx.fill();
    targetCtx.stroke();

    targetCtx.fillStyle = '#e11d48';
    targetCtx.font = 'bold 20px sans-serif';
    targetCtx.textAlign = 'center';
    targetCtx.textBaseline = 'middle';
    targetCtx.fillText(circledNumber(marker.number), marker.x, marker.y + 1);

    if (includeHandle && isSelected) {
      targetCtx.fillStyle = '#2563eb';
      targetCtx.beginPath();
      targetCtx.arc(handle.x, handle.y, 7, 0, Math.PI * 2);
      targetCtx.fill();
    }
  }

  targetCtx.restore();
}

function circledNumber(n) {
  const map = ['⓪','①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩','⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'];
  return map[n] || String(n);
}

function renderInfoList() {
  const selectedId = state.selectedMarkerId;
  const markers = [...state.markers].sort((a, b) => a.number - b.number);
  infoList.innerHTML = '';
  if (!markers.length) {
    const empty = document.createElement('div');
    empty.className = 'subhint';
    empty.textContent = 'まだ番号がありません。画像をクリックすると追加されます。';
    infoList.appendChild(empty);
    return;
  }
  for (const marker of markers) {
    const item = document.createElement('div');
    item.className = 'info-item' + (marker.id === selectedId ? ' active' : '');
    item.dataset.id = marker.id;

    const head = document.createElement('div');
    head.className = 'info-head';
    head.textContent = `${circledNumber(marker.number)} 入力内容`;

    const textarea = document.createElement('textarea');
    textarea.value = marker.text;
    textarea.placeholder = '修正指示を入力';
    textarea.dataset.markerId = marker.id;
    textarea.addEventListener('focus', () => clearSelection());
    textarea.addEventListener('pointerdown', () => clearSelection());
    textarea.addEventListener('input', async () => {
      marker.text = textarea.value;
      await syncAfterTextChange(false);
    });

    item.addEventListener('pointerdown', (event) => {
      if (event.target.closest('textarea')) return;
      selectMarker(marker.id);
    });
    item.append(head, textarea);
    infoList.appendChild(item);
  }
}

function scrollInfoItemIntoView(markerId) {
  if (!markerId) return;
  const item = infoList.querySelector(`.info-item[data-id="${markerId}"]`);
  if (!item) return;

  const listRect = infoList.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const margin = 16;

  if (itemRect.top < listRect.top + margin) {
    infoList.scrollTop -= (listRect.top + margin) - itemRect.top;
  } else if (itemRect.bottom > listRect.bottom - margin) {
    infoList.scrollTop += itemRect.bottom - (listRect.bottom - margin);
  }
}

async function syncAfterTextChange(refreshList = true) {
  state.updatedAt = new Date().toISOString();
  if (refreshList) renderInfoList();
  await renderPreview();
  await autosave();
}

async function exportState() {
  state.updatedAt = new Date().toISOString();
  await autosave();
  const data = JSON.stringify(state, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  try {
    await chrome.downloads.download({
      url,
      filename: `instruction-sheet-${timestamp()}-ver${APP_VERSION}.json`,
      saveAs: true
    });
    saveState.textContent = 'JSONを書き出しました';
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

async function renderPreview() {
  const markers = [...state.markers].sort((a, b) => a.number - b.number);
  const width = imageWidth();
  const layout = buildBottomLayout(previewCtx, markers, width);
  const bottomHeight = Math.max(120, layout.height);

  previewCanvas.width = width;
  previewCanvas.height = imageHeight() + bottomHeight;

  const img = await loadImage(state.screenshot);
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  previewCtx.fillStyle = '#ffffff';
  previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
  previewCtx.drawImage(img, 0, 0, imageWidth(), imageHeight());
  drawMarkers(previewCtx, 1, 1, false, null);

  previewCtx.fillStyle = '#ffffff';
  previewCtx.fillRect(0, imageHeight(), width, bottomHeight);
  previewCtx.strokeStyle = '#d9dfeb';
  previewCtx.lineWidth = 2;
  previewCtx.beginPath();
  previewCtx.moveTo(0, imageHeight());
  previewCtx.lineTo(width, imageHeight());
  previewCtx.stroke();

  drawBottomLayout(previewCtx, layout, imageHeight());
}

function buildBottomLayout(targetCtx, markers, width) {
  const paddingX = 36;
  const paddingTop = 28;
  const paddingBottom = 28;
  const gutterX = 24;
  const gutterY = 20;
  const boxPaddingX = 20;
  const boxPaddingY = 16;
  const maxColumnsPerRow = 3;
  const lineHeight = 34;
  const titleGap = 10;

  const usableWidth = Math.max(1, width - paddingX * 2);
  const columnCount = Math.max(1, Math.min(maxColumnsPerRow, markers.length || 1));
  const columnWidth = (usableWidth - gutterX * (columnCount - 1)) / columnCount;

  targetCtx.save();
  targetCtx.font = '28px sans-serif';

  const items = [];
  let currentY = paddingTop;

  for (let start = 0; start < markers.length; start += columnCount) {
    const rowMarkers = markers.slice(start, start + columnCount);
    const rowItems = rowMarkers.map((marker, index) => {
      const title = `${circledNumber(marker.number)} 入力内容`;
      const bodyText = marker.text || '入力内容';
      const lines = wrapText(targetCtx, bodyText, Math.max(80, columnWidth - boxPaddingX * 2));
      const bodyHeight = Math.max(lineHeight, lines.length * lineHeight);
      const itemHeight = boxPaddingY * 2 + lineHeight + titleGap + bodyHeight;
      const x = paddingX + index * (columnWidth + gutterX);
      return {
        x,
        width: columnWidth,
        title,
        lines,
        measuredHeight: itemHeight
      };
    });

    const rowHeight = rowItems.length
      ? Math.max(...rowItems.map(item => item.measuredHeight))
      : 0;

    for (const item of rowItems) {
      items.push({
        x: item.x,
        y: currentY,
        width: item.width,
        height: rowHeight,
        title: item.title,
        lines: item.lines
      });
    }

    currentY += rowHeight + gutterY;
  }

  targetCtx.restore();

  const contentBottom = items.length
    ? Math.max(...items.map(item => item.y + item.height))
    : paddingTop + 32;

  return {
    width,
    height: contentBottom + paddingBottom,
    columnWidth,
    items,
    style: {
      paddingX,
      paddingTop,
      paddingBottom,
      gutterX,
      gutterY,
      boxPaddingX,
      boxPaddingY,
      lineHeight,
      titleGap,
      maxColumnsPerRow
    }
  };
}

function drawBottomLayout(targetCtx, layout, offsetY) {
  const { items, style } = layout;

  for (const item of items) {
    const x = item.x;
    const y = offsetY + item.y;

    targetCtx.fillStyle = '#f8fafc';
    targetCtx.strokeStyle = '#d9dfeb';
    targetCtx.lineWidth = 2;
    roundRect(targetCtx, x, y, item.width, item.height, 16);
    targetCtx.fill();
    targetCtx.stroke();

    targetCtx.fillStyle = '#111827';
    targetCtx.font = 'bold 28px sans-serif';
    targetCtx.textAlign = 'left';
    targetCtx.textBaseline = 'top';
    targetCtx.fillText(item.title, x + style.boxPaddingX, y + style.boxPaddingY);

    targetCtx.fillStyle = '#1f2937';
    targetCtx.font = '28px sans-serif';
    let lineY = y + style.boxPaddingY + style.lineHeight + style.titleGap;
    for (const line of item.lines) {
      targetCtx.fillText(line, x + style.boxPaddingX, lineY);
      lineY += style.lineHeight;
    }
  }
}

function wrapText(targetCtx, text, maxWidth) {
  const raw = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  for (const paragraph of raw) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const char of Array.from(paragraph)) {
      const candidate = current + char;
      if (current && targetCtx.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = char;
      } else {
        current = candidate;
      }
    }
    lines.push(current || '');
  }
  return lines.length ? lines : [''];
}

function roundRect(targetCtx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  targetCtx.beginPath();
  targetCtx.moveTo(x + r, y);
  targetCtx.arcTo(x + width, y, x + width, y + height, r);
  targetCtx.arcTo(x + width, y + height, x, y + height, r);
  targetCtx.arcTo(x, y + height, x, y, r);
  targetCtx.arcTo(x, y, x + width, y, r);
  targetCtx.closePath();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function autosave() {
  state.updatedAt = new Date().toISOString();
  await idbSet(AUTOSAVE_KEY, state);
  await chrome.storage.local.set({ hasAutosave: true });
  saveState.textContent = `自動保存済み (${new Date().toLocaleTimeString('ja-JP')})`;
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

async function downloadDataUrl(dataUrl, filename) {
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
