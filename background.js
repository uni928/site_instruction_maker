chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'CAPTURE_FULL_PAGE') {
    (async () => {
      try {
        const draft = await captureFullPage(message.tabId, message.windowId);
        await chrome.storage.local.set({ pendingCaptureState: draft });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || 'capture failed' });
      }
    })();
    return true;
  }

  if (message?.type === 'CAPTURE_VISIBLE_SCREENSHOT') {
    (async () => {
      try {
        const dataUrl = await captureVisibleTabWithQuotaGuard(message.windowId);
        const normalized = await normalizeTo1920(dataUrl);
        const draft = {
          version: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          screenshot: normalized,
          originalCapture: dataUrl,
          markers: [],
          nextId: 1,
          selectedMarkerId: null,
          captureMode: 'visible'
        };
        await chrome.storage.local.set({ pendingCaptureState: draft });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || 'capture failed' });
      }
    })();
    return true;
  }
});

const CAPTURE_MIN_INTERVAL_MS = 1200;
let lastCaptureAt = 0;

async function captureVisibleTabWithQuotaGuard(windowId, options = {}) {
  const {
    format = 'png',
    retries = 4,
    minIntervalMs = CAPTURE_MIN_INTERVAL_MS
  } = options;

  let attempt = 0;

  while (true) {
    const waitMs = Math.max(0, lastCaptureAt + minIntervalMs - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format });
      lastCaptureAt = Date.now();
      return dataUrl;
    } catch (error) {
      const message = error?.message || '';
      const isQuotaError =
        message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND') ||
        message.includes('captureVisibleTab');

      if (!isQuotaError || attempt >= retries) {
        throw error;
      }

      attempt += 1;

      const backoffMs = minIntervalMs * attempt;
      await sleep(backoffMs);
      lastCaptureAt = Date.now();
    }
  }
}

async function captureFullPage(tabId, windowId) {
  const [{ result: prepared }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: preparePageForFullCapture
  });

  if (!prepared?.ok) {
    throw new Error(prepared?.error || 'ページ情報を取得できませんでした。');
  }

  const positions = prepared.positions || [];
  const metrics = prepared.metrics;
  if (!positions.length || !metrics?.pageWidth || !metrics?.pageHeight) {
    await safeRestorePage(tabId);
    throw new Error('撮影対象のページサイズを取得できませんでした。');
  }

  let stitchedCanvas = null;
  let stitchedCtx = null;
  let scale = 0;

  try {
    for (const pos of positions) {
      const [{ result: actualPos }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: scrollToCapturePosition,
        args: [pos.x, pos.y]
      });

      await sleep(250);

      const dataUrl = await captureVisibleTabWithQuotaGuard(windowId);
      const bitmap = await dataUrlToBitmap(dataUrl);

      if (!scale) {
        scale = bitmap.width / metrics.viewportWidth;
        const canvasWidth = Math.max(1, Math.round(metrics.pageWidth * scale));
        const canvasHeight = Math.max(1, Math.round(metrics.pageHeight * scale));
        stitchedCanvas = new OffscreenCanvas(canvasWidth, canvasHeight);
        stitchedCtx = stitchedCanvas.getContext('2d');
        stitchedCtx.imageSmoothingEnabled = true;
      }

      const destX = Math.round(actualPos.x * scale);
      const destY = Math.round(actualPos.y * scale);
      const drawWidth = Math.min(bitmap.width, stitchedCanvas.width - destX);
      const drawHeight = Math.min(bitmap.height, stitchedCanvas.height - destY);

      if (drawWidth > 0 && drawHeight > 0) {
        stitchedCtx.drawImage(
          bitmap,
          0, 0, drawWidth, drawHeight,
          destX, destY, drawWidth, drawHeight
        );
      }
    }
  } finally {
    await safeRestorePage(tabId);
  }

  if (!stitchedCanvas) {
    throw new Error('フルページ画像の生成に失敗しました。');
  }

  const mergedBlob = await stitchedCanvas.convertToBlob({ type: 'image/png' });
  const mergedDataUrl = await blobToDataUrl(mergedBlob);
  const normalized = await normalizeTo1920(mergedDataUrl);

  return {
    version: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    screenshot: normalized,
    originalCapture: mergedDataUrl,
    markers: [],
    nextId: 1,
    selectedMarkerId: null,
    captureMode: 'fullpage',
    sourcePage: {
      width: metrics.pageWidth,
      height: metrics.pageHeight,
      url: prepared.url || ''
    }
  };
}

async function safeRestorePage(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: restorePageAfterFullCapture
    });
  } catch (error) {
    // ignore restore failures
  }
}

function preparePageForFullCapture() {
  try {
    const doc = document.documentElement;
    const body = document.body;
    const pageWidth = Math.max(
      doc.scrollWidth,
      doc.clientWidth,
      body ? body.scrollWidth : 0,
      body ? body.clientWidth : 0
    );
    const pageHeight = Math.max(
      doc.scrollHeight,
      doc.clientHeight,
      body ? body.scrollHeight : 0,
      body ? body.clientHeight : 0
    );
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const maxX = Math.max(0, pageWidth - viewportWidth);
    const maxY = Math.max(0, pageHeight - viewportHeight);

    const xs = [];
    const ys = [];

    for (let x = 0; x < pageWidth; x += viewportWidth) {
      const value = Math.min(x, maxX);
      if (!xs.length || xs[xs.length - 1] !== value) xs.push(value);
    }
    if (!xs.length) xs.push(0);

    for (let y = 0; y < pageHeight; y += viewportHeight) {
      const value = Math.min(y, maxY);
      if (!ys.length || ys[ys.length - 1] !== value) ys.push(value);
    }
    if (!ys.length) ys.push(0);

    if (!document.getElementById('sim-capture-hide-style')) {
      const style = document.createElement('style');
      style.id = 'sim-capture-hide-style';
      style.textContent = `
        html { scroll-behavior: auto !important; }
        [data-sim-capture-hidden="1"] {
          visibility: hidden !important;
          pointer-events: none !important;
        }
      `;
      document.head.appendChild(style);
    }

    const fixedLike = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if ((cs.position === 'fixed' || cs.position === 'sticky') && cs.display !== 'none' && cs.visibility !== 'hidden') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          el.setAttribute('data-sim-capture-hidden', '1');
          fixedLike.push(true);
        }
      }
    }

    window.__simCaptureOriginalScrollX = window.scrollX;
    window.__simCaptureOriginalScrollY = window.scrollY;
    window.scrollTo(0, 0);

    const positions = [];
    for (const y of ys) {
      for (const x of xs) {
        positions.push({ x, y });
      }
    }

    return {
      ok: true,
      url: location.href,
      metrics: { pageWidth, pageHeight, viewportWidth, viewportHeight },
      positions,
      hiddenCount: fixedLike.length
    };
  } catch (error) {
    return { ok: false, error: error.message || 'prepare failed' };
  }
}

function scrollToCapturePosition(x, y) {
  window.scrollTo({ left: x, top: y, behavior: 'auto' });
  return { x: window.scrollX, y: window.scrollY };
}

function restorePageAfterFullCapture() {
  const hidden = document.querySelectorAll('[data-sim-capture-hidden="1"]');
  hidden.forEach(el => el.removeAttribute('data-sim-capture-hidden'));
  const style = document.getElementById('sim-capture-hide-style');
  if (style) style.remove();
  const x = window.__simCaptureOriginalScrollX || 0;
  const y = window.__simCaptureOriginalScrollY || 0;
  window.scrollTo({ left: x, top: y, behavior: 'auto' });
  delete window.__simCaptureOriginalScrollX;
  delete window.__simCaptureOriginalScrollY;
}

async function normalizeTo1920(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const width = 1920;
  const height = Math.max(1, Math.round(bitmap.height * (width / bitmap.width)));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  return await blobToDataUrl(outBlob);
}

async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return await createImageBitmap(blob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
