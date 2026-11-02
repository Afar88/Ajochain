import { wallet } from './wallet';

const VALID_NETWORKS = new Set(['chipnet', 'mainnet']);

function safeNetwork() {
  const saved = localStorage.getItem('ajo-net');
  if (!VALID_NETWORKS.has(saved || '')) {
    localStorage.setItem('ajo-net', 'chipnet');
    return 'chipnet';
  }
  return saved!;
}

// Keep persisted network state valid. Invalid/stale values must never break the app on boot.
safeNetwork();

// Fix legacy/alternate PUSD routes and make the SPA recover from malformed hashes.
function normalizeHash() {
  const hash = location.hash;
  if (hash === '#/pusd/create' || hash === '#/create?asset=pusd' || hash === '#/create/?asset=pusd') {
    history.replaceState(null, '', '#/create/pusd');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
}

// Add interaction safety without changing the contract flow: prevent accidental double
// clicks while a transaction is being approved, and restore controls after navigation.
function hardenButtons(root: ParentNode = document) {
  root.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    if (button.dataset.hardened === '1') return;
    button.dataset.hardened = '1';
    button.addEventListener('click', () => {
      if (button.disabled || button.dataset.busy === '1') return;
      const label = button.textContent?.trim() || '';
      if (!/pay|contribut|start|create/i.test(label)) return;
      button.dataset.busy = '1';
      button.dataset.originalText = label;
      button.disabled = true;
      button.textContent = /pay/i.test(label) ? 'Processing…' : 'Preparing…';
      window.setTimeout(() => {
        // A transaction can take longer than this, but this only releases the UI guard;
        // the wallet/contract layer remains responsible for the actual transaction state.
        if (button.isConnected) {
          button.disabled = false;
          button.dataset.busy = '0';
          button.textContent = button.dataset.originalText || label;
        }
      }, 30000);
    });
  });

  root.querySelectorAll<HTMLElement>('.err, .note').forEach((el) => {
    if (!el.hasAttribute('role')) el.setAttribute('role', 'status');
    if (!el.hasAttribute('aria-live')) el.setAttribute('aria-live', 'polite');
  });
}

function installAccessibility() {
  const modal = document.querySelector<HTMLElement>('#modal');
  if (modal) {
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
