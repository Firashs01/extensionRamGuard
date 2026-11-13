/**
 * TabSaver Pro — Suspended Tab Placeholder
 * =========================================
 * Parses URL params, populates the placeholder UI, and handles
 * restore / copy / close actions.
 */

(() => {

/* Types are declared globally via types.ts (module: None). */

/* ── DOM refs ────────────────────────────────────────── */

const faviconImg   = document.getElementById('favicon') as HTMLImageElement;
const pageTitle    = document.getElementById('page-title') as HTMLHeadingElement;
const pageUrl      = document.getElementById('page-url') as HTMLParagraphElement;
const btnCopy      = document.getElementById('btn-copy') as HTMLButtonElement;
const btnClose     = document.getElementById('btn-close') as HTMLButtonElement;
const overlay      = document.getElementById('restore-overlay') as HTMLDivElement;

/* ── Parse search params ─────────────────────────────── */

const params      = new URLSearchParams(window.location.search);
const originalUrl = params.get('url') ?? '';
const tabTitle    = params.get('title') ?? 'Suspended Tab';
const faviconUrl  = params.get('favicon') ?? '';

/* ── Populate UI ─────────────────────────────────────── */

document.title = `💤 ${tabTitle}`;

pageTitle.textContent = tabTitle;

if (originalUrl) {
  pageUrl.textContent = originalUrl;
  pageUrl.title = originalUrl;               // full URL on hover
} else {
  pageUrl.textContent = 'No URL available';
}

if (faviconUrl) {
  faviconImg.src = faviconUrl;
  faviconImg.alt = `${tabTitle} favicon`;
  faviconImg.onerror = () => {
    faviconImg.style.display = 'none';       // hide broken images
  };
} else {
  faviconImg.style.display = 'none';
}

/* ── Restore tab ─────────────────────────────────────── */

async function restoreTab(): Promise<void> {
  if (!originalUrl) return;

  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) {
      await chrome.tabs.update(tab.id, { url: originalUrl });
    }
  } catch {
    // Fallback: ask background to handle it
    const msg: ExtensionMessage = { type: 'RESTORE_TAB' };
    chrome.runtime.sendMessage(msg);
  }
}

overlay.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  // Don't restore if the user clicked one of the action buttons
  if (target.closest('.btn-ghost')) return;
  restoreTab();
});

overlay.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    restoreTab();
  }
});

/* ── Copy URL ────────────────────────────────────────── */

btnCopy.addEventListener('click', async () => {
  if (!originalUrl) return;

  try {
    await navigator.clipboard.writeText(originalUrl);
    btnCopy.setAttribute('data-copied', 'true');
    const origText = btnCopy.innerHTML;
    btnCopy.innerHTML = '<span class="btn-icon">✓</span> Copied!';

    setTimeout(() => {
      btnCopy.innerHTML = origText;
      btnCopy.removeAttribute('data-copied');
    }, 1500);
  } catch {
    // Clipboard API may fail without focus / permissions — silent fail
  }
});

/* ── Close tab ───────────────────────────────────────── */

btnClose.addEventListener('click', async () => {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) {
      await chrome.tabs.remove(tab.id);
    }
  } catch {
    window.close();
  }
});

})();
