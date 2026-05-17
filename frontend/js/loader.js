// ============================================================
// loader.js — Loading overlay management
// ============================================================

const overlay  = document.getElementById('loading-overlay');
const msgEl    = document.getElementById('loading-msg');
const barEl    = document.getElementById('loading-bar');
const detailEl = document.getElementById('loading-detail');

export function loadingShow(msg = 'Loading...', pct = 0, detail = '') {
  if (window.__stopLoadingAnim) { window.__stopLoadingAnim(); window.__stopLoadingAnim = null; }
  overlay.classList.remove('hidden');
  msgEl.textContent    = msg;
  barEl.style.width    = `${pct}%`;
  detailEl.textContent = detail;
}

export function loadingProgress(pct, detail = '') {
  barEl.style.width    = `${Math.min(pct, 100)}%`;
  detailEl.textContent = detail;
}

export function loadingHide() {
  if (window.__stopLoadingAnim) { window.__stopLoadingAnim(); window.__stopLoadingAnim = null; }
  barEl.style.width = '100%';
  setTimeout(() => overlay.classList.add('hidden'), 300);
}
