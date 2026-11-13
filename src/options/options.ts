/**
 * TabSaver Pro — Options Page Script
 * ===================================
 * Loads settings, whitelist & stats from chrome.storage.local,
 * syncs toggle changes immediately via message to background,
 * and debounce-saves the whitelist textarea.
 */

(() => {

/* Types are declared globally via types.ts (module: None). */

const OPTIONS_DEFAULT_SETTINGS: ExtensionSettings = {
  inactivityMinutes: 30,
  neverSuspendAudible: true,
  neverSuspendPinned: true,
  neverSuspendDirtyForms: true,
  onlyOnBattery: false,
  usePlaceholderPage: false,
  visualIndicators: false,
};

const OPTIONS_RAM_PER_TAB_MB = 70;

/* ── Setting ↔ Toggle ID map ───────────────────────── */

const TOGGLE_IDS: (keyof ExtensionSettings)[] = [
  'neverSuspendAudible',
  'neverSuspendPinned',
  'neverSuspendDirtyForms',
  'onlyOnBattery',
  'usePlaceholderPage',
  'visualIndicators',
];

/* ── DOM refs ──────────────────────────────────────── */

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function $toggle(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

const whitelistEl = $('whitelist') as HTMLTextAreaElement;
const saveStatusEl = $('saveStatus');
const totalSuspendedEl = $('totalSuspended');
const totalRamSavedEl = $('totalRamSaved');

/* ── Formatting helpers ────────────────────────────── */

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatRam(mb: number): string {
  if (mb >= 1024) {
    return `~${(mb / 1024).toFixed(1)} GB`;
  }
  return `${mb.toFixed(1)} MB`;
}

/* ── Load from storage ─────────────────────────────── */

async function loadAll(): Promise<void> {
  const result = await chrome.storage.local.get([
    'settings',
    'whitelist',
    'totalTabsSuspended',
    'totalRamSavedMB',
  ]) as Partial<StorageSchema>;

  const settings: ExtensionSettings = { ...OPTIONS_DEFAULT_SETTINGS, ...result.settings };
  const whitelist: string[] = result.whitelist ?? [];
  const totalSuspended: number = result.totalTabsSuspended ?? 0;
  const totalRamMB: number = result.totalRamSavedMB ?? 0;

  // Populate toggles
  for (const key of TOGGLE_IDS) {
    $toggle(key).checked = settings[key] as boolean;
  }

  // Populate whitelist
  whitelistEl.value = whitelist.join('\n');

  // Populate stats
  totalSuspendedEl.textContent = formatNumber(totalSuspended);
  totalRamSavedEl.textContent = formatRam(totalRamMB);
}

/* ── Save settings via message to background ───────── */

async function saveSettings(): Promise<void> {
  const updated: ExtensionSettings = { ...OPTIONS_DEFAULT_SETTINGS };
  for (const key of TOGGLE_IDS) {
    (updated as unknown as Record<string, boolean>)[key] = $toggle(key).checked;
  }

  const message: ExtensionMessage = {
    type: 'UPDATE_SETTINGS',
    payload: updated,
  };

  chrome.runtime.sendMessage(message);
}

/* ── Save whitelist (debounced) ────────────────────── */

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function saveWhitelistDebounced(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(async () => {
    const lines = whitelistEl.value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    await chrome.storage.local.set({ whitelist: lines });
    showSaveStatus();
  }, 500);
}

function showSaveStatus(): void {
  saveStatusEl.classList.add('visible');
  setTimeout(() => {
    saveStatusEl.classList.remove('visible');
  }, 1500);
}

/* ── Event Listeners ───────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  loadAll();

  // Toggle change listeners
  for (const key of TOGGLE_IDS) {
    $toggle(key).addEventListener('change', () => {
      saveSettings();
    });
  }

  // Whitelist debounced save
  whitelistEl.addEventListener('input', () => {
    saveWhitelistDebounced();
  });
});

})();
