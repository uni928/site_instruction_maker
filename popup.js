const statusEl = document.getElementById('status');
const captureBtn = document.getElementById('captureBtn');
const visibleCaptureBtn = document.getElementById('visibleCaptureBtn');
const resumeBtn = document.getElementById('resumeBtn');
const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#dc2626' : '#627089';
}

async function openEditor(mode) {
  const url = chrome.runtime.getURL(`editor.html?mode=${encodeURIComponent(mode)}`);
  await chrome.tabs.create({ url });
  window.close();
}

async function capture(mode) {
  try {
    setStatus(mode === 'full' ? 'フルページを撮影しています…' : '表示範囲を撮影しています…');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.runtime.sendMessage({
      type: mode === 'full' ? 'CAPTURE_FULL_PAGE' : 'CAPTURE_VISIBLE_SCREENSHOT',
      tabId: tab.id,
      windowId: tab.windowId
    });
    if (!response?.ok) throw new Error(response?.error || '撮影に失敗しました。');
    await chrome.storage.local.set({ pendingImportedState: null });
    await openEditor('capture');
  } catch (error) {
    setStatus(error.message || '撮影に失敗しました。', true);
  }
}

captureBtn.addEventListener('click', () => capture('full'));
visibleCaptureBtn.addEventListener('click', () => capture('visible'));

resumeBtn.addEventListener('click', async () => {
  const result = await chrome.storage.local.get(['hasAutosave']);
  if (!result.hasAutosave) {
    setStatus('前回の自動保存データが見つかりません。', true);
    return;
  }
  await openEditor('resume');
});

importBtn.addEventListener('click', () => importFile.click());

importFile.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || !parsed.screenshot || !Array.isArray(parsed.markers)) {
      throw new Error('インポート形式が正しくありません。');
    }
    await chrome.storage.local.set({ pendingImportedState: parsed });
    await openEditor('import');
  } catch (error) {
    setStatus(error.message || 'インポートに失敗しました。', true);
  } finally {
    importFile.value = '';
  }
});
