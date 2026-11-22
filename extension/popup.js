const status = document.getElementById('status');
const opt = document.getElementById('opt');
const openBtn = document.getElementById('open');
const hint = document.getElementById('hint');

opt.addEventListener('click', () => chrome.runtime.openOptionsPage());

// Provider status line
chrome.storage.sync.get().then((all) => {
  const activeProvider = all.activeProvider || (all.apiKey ? 'anthropic' : null);
  const providerCfg = all.providers?.[activeProvider] || {};

  // Backward-compat read for v1.0.x storage
  const hasAnthropicKey = providerCfg.apiKey || all.apiKey;

  const hasCreds = (() => {
    if (!activeProvider) return false;
    if (activeProvider === 'anthropic') return !!hasAnthropicKey;
    if (activeProvider === 'openai' || activeProvider === 'gemini') return !!providerCfg.apiKey;
    if (activeProvider === 'ollama') return true; // baseUrl has a default
    return false;
  })();

  if (!activeProvider || !hasCreds) {
    status.className = 'status warn';
    status.textContent = '⚠ Not configured — open Settings.';
  } else {
    const label =
      activeProvider === 'anthropic'
        ? 'Anthropic'
        : activeProvider === 'openai'
        ? 'OpenAI'
        : activeProvider === 'gemini'
        ? 'Gemini'
        : 'Ollama';
    const model = providerCfg.model || all.model || '';
    status.className = 'status ok';
    status.textContent = `✓ Ready · ${label}${model ? ' / ' + model : ''}`;
  }
});

function videoIdFrom(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'www.youtube.com' || u.pathname !== '/watch') return null;
    return u.searchParams.get('v');
  } catch {
    return null;
  }
}

// If this tab's video already has a summary (saved, minimized or being generated),
// offer to open it instead of just showing Settings.
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !videoIdFrom(tab.url || '')) return;

  let info = null;
  try {
    info = await chrome.tabs.sendMessage(tab.id, { type: 'yts-status' });
  } catch {
    // Content script not reachable (e.g. tab opened before the extension was reloaded).
    const key = 'sum:' + videoIdFrom(tab.url);
    const saved = (await chrome.storage.local.get(key))[key];
    if (saved) {
      hint.textContent = 'A summary is saved for this video. Refresh the YouTube tab to open it.';
      hint.hidden = false;
    }
    return;
  }
  if (!info?.hasSummary) return;

  openBtn.textContent = info.inProgress ? 'Open summary (generating…)' : 'Open summary';
  openBtn.hidden = false;
  opt.classList.add('secondary');
  openBtn.addEventListener('click', async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'yts-open' });
    } catch {}
    window.close();
  });
})();
