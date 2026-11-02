import { wallet } from './wallet';

const VALID_NETWORKS = new Set(['chipnet', 'mainnet']);

function safeNetwork() {
  const saved = localStorage.getItem('ajo-net');
  if (!VALID_NETWORKS.has(saved || '')) localStorage.setItem('ajo-net', 'chipnet');
}

safeNetwork();

// Recover legacy/alternate PUSD routes and keep old bookmarks working.
function normalizeHash() {
  const hash = location.hash;
  if (hash === '#/pusd/create' || hash === '#/create?asset=pusd' || hash === '#/create/?asset=pusd') {
    history.replaceState(null, '', '#/create/pusd');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
}

// Prevent accidental double taps without interfering with the app's async transaction state.
function hardenButtons(root: ParentNode = document) {
  root.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    if (button.dataset.hardened === '1') return;
    button.dataset.hardened = '1';
    let lastClick = 0;
    button.addEventListener('click', (event) => {
      const now = Date.now();
      if (now - lastClick < 900) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      lastClick = now;
    }, true);
  });

  root.querySelectorAll<HTMLElement>('.err, .note').forEach((el) => {
    if (!el.hasAttribute('role')) el.setAttribute('role', 'status');
    if (!el.hasAttribute('aria-live')) el.setAttribute('aria-live', 'polite');
  });
}

function installAccessibility() {
  const modal = document.querySelector<HTMLElement>('#modal');
  if (!modal) return;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.classList.contains('show')) {
      modal.classList.remove('show');
      if (wallet.state !== 'connected') wallet.disconnect();
    }
  });
  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      modal.classList.remove('show');
      if (wallet.state !== 'connected') wallet.disconnect();
    }
  });
}

function observeApp() {
  const app = document.querySelector('#app');
  if (!app) return;
  const observer = new MutationObserver(() => hardenButtons(app));
  observer.observe(app, { childList: true, subtree: true });
  hardenButtons(app);
}

normalizeHash();
installAccessibility();
observeApp();
window.addEventListener('hashchange', normalizeHash);
