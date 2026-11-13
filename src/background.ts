/**
 * TabSaver Pro — Background Service Worker (Manifest V3)
 * ======================================================
 * Tracks tab activity, auto-suspends inactive tabs, and handles
 * messages from popup / content scripts.
 */

(() => {

/* ── Inlined Constants (no module imports in MV3) ──── */

const RAM_PER_TAB_MB = 70;
const ALARM_NAME = 'tabsaver-check';

const DEFAULT_SETTINGS: ExtensionSettings = {
  inactivityMinutes: 30,
  neverSuspendAudible: true,
  neverSuspendPinned: true,
  neverSuspendDirtyForms: true,
  onlyOnBattery: false,
  usePlaceholderPage: false,
  visualIndicators: false,
};

const IGNORED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'devtools://',
  'chrome-devtools://',
  'brave://',
  'file://',
];

/* ── Helpers ──────────────────────────────────────────── */

/** Load a subset of storage with sane defaults. */
async function loadStorage(): Promise<StorageSchema> {
  const raw = await chrome.storage.local.get([
    'settings',
    'tabStates',
    'whitelist',
    'totalTabsSuspended',
    'totalRamSavedMB',
  ]);

  return {
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) } as ExtensionSettings,
    tabStates: (raw.tabStates ?? {}) as Record<number, TabState>,
    whitelist: (raw.whitelist ?? []) as string[],
    totalTabsSuspended: (raw.totalTabsSuspended ?? 0) as number,
    totalRamSavedMB: (raw.totalRamSavedMB ?? 0) as number,
  };
}

/** Persist individual keys. */
async function saveStorage(partial: Partial<StorageSchema>): Promise<void> {
  await chrome.storage.local.set(partial);
}

/** Extract hostname from a URL string, or null on failure. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Check if a URL starts with any ignored prefix. */
function isIgnoredUrl(url: string): boolean {
  return IGNORED_URL_PREFIXES.some((p) => url.startsWith(p));
}

/**
 * Match a hostname against a whitelist.
 *  - Exact: `github.com` matches `github.com`
 *  - Wildcard: `*.figma.com` matches `app.figma.com`, `www.figma.com`
 */
function isWhitelisted(hostname: string, whitelist: string[]): boolean {
  for (const pattern of whitelist) {
    if (pattern.startsWith('*.')) {
      const root = pattern.slice(2); // e.g. "figma.com"
      if (hostname === root || hostname.endsWith(`.${root}`)) {
        return true;
      }
    } else if (hostname === pattern) {
      return true;
    }
  }
  return false;
}

/** Get a set of currently active tab IDs (one per focused window). */
async function getActiveTabIds(): Promise<Set<number>> {
  const ids = new Set<number>();
  try {
    const tabs = await chrome.tabs.query({ active: true });
    for (const t of tabs) {
      if (t.id != null) ids.add(t.id);
    }
  } catch {
    // Tabs API may throw during shutdown.
  }
  return ids;
}

/** Cached battery-on-power state (refreshed every alarm cycle). */
let cachedIsOnBattery = false;

async function refreshBatteryState(): Promise<void> {
  // The Battery Status API is available in service workers in some
  // Chromium builds. Fall back gracefully when unavailable.
  try {
    if ('getBattery' in navigator) {
      const battery = await (navigator as any).getBattery();
      cachedIsOnBattery = !battery.charging;
    }
  } catch {
    // Not available — leave the cached value unchanged.
  }
}

/* ── Suspension Logic ─────────────────────────────────── */

/** Build the placeholder-page URL. */
function buildPlaceholderUrl(tab: TabState): string {
  const params = new URLSearchParams({
    url: tab.url,
    title: tab.title,
    favicon: tab.favIconUrl ?? '',
  });
  return chrome.runtime.getURL(`src/suspended/suspended.html?${params.toString()}`);
}

/** Suspend a single tab: discard or redirect to placeholder. */
async function suspendTab(
  tabId: number,
  tabState: TabState,
  usePlaceholder: boolean,
): Promise<boolean> {
  try {
    if (usePlaceholder) {
      await chrome.tabs.update(tabId, { url: buildPlaceholderUrl(tabState) });
    } else {
      await chrome.tabs.discard(tabId);
    }
    return true;
  } catch {
    // Tab might be undiscardable (e.g. DevTools, active tab).
    return false;
  }
}

/** Apply a visual "dim" indicator via content script before suspending. */
async function applyVisualDim(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'APPLY_VISUAL_DIM',
    } as ExtensionMessage);
  } catch {
    // Content script may not be injected.
  }
}

/* ── Badge ────────────────────────────────────────────── */

async function updateBadge(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    const discardedCount = tabs.filter((t) => t.discarded).length;
    await chrome.action.setBadgeText({
      text: discardedCount > 0 ? String(discardedCount) : '',
    });
    await chrome.action.setBadgeBackgroundColor({ color: '#10B981' });
  } catch {
    // Badge API may not be available in test contexts.
  }
}

/* ── Alarm Cycle ──────────────────────────────────────── */

async function runSuspensionCheck(): Promise<void> {
  const { settings, tabStates, whitelist, totalTabsSuspended, totalRamSavedMB } =
    await loadStorage();

  // If inactivity threshold is 0 ("Off"), skip the entire check.
  if (settings.inactivityMinutes === 0) {
    await updateBadge();
    return;
  }

  await refreshBatteryState();

  // If "only on battery" is on but device is on AC, skip.
  if (settings.onlyOnBattery && !cachedIsOnBattery) {
    await updateBadge();
    return;
  }

  const activeTabIds = await getActiveTabIds();
  const now = Date.now();
  const thresholdMs = settings.inactivityMinutes * 60 * 1000;

  let suspendedThisCycle = 0;

  for (const [idStr, state] of Object.entries(tabStates)) {
    const tabId = Number(idStr);

    // Already suspended.
    if (state.discardedAt != null) continue;

    // Active tab in a window — never suspend.
    if (activeTabIds.has(tabId)) continue;

    // Ignored URL prefix.
    if (isIgnoredUrl(state.url)) continue;

    // Whitelist check.
    const hostname = hostnameOf(state.url);
    if (hostname && isWhitelisted(hostname, whitelist)) continue;

    // Per-setting exemptions.
    if (settings.neverSuspendAudible && state.isAudible) continue;
    if (settings.neverSuspendPinned && state.isPinned) continue;
    if (settings.neverSuspendDirtyForms && state.hasDirtyForm) continue;

    // Not inactive long enough.
    if (now - state.lastActiveAt < thresholdMs) continue;

    // ── Eligible for suspension ──

    // Visual dim before suspending.
    if (settings.visualIndicators) {
      await applyVisualDim(tabId);
    }

    const success = await suspendTab(tabId, state, settings.usePlaceholderPage);
    if (success) {
      state.discardedAt = now;
      suspendedThisCycle++;
    }
  }

  // Persist updated counters & states.
  await saveStorage({
    tabStates,
    totalTabsSuspended: totalTabsSuspended + suspendedThisCycle,
    totalRamSavedMB: totalRamSavedMB + suspendedThisCycle * RAM_PER_TAB_MB,
  });

  await updateBadge();
}

/* ── Tab Event Listeners ──────────────────────────────── */

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const { tabStates } = await loadStorage();
    const state = tabStates[activeInfo.tabId];
    if (state) {
      state.lastActiveAt = Date.now();
      await saveStorage({ tabStates });
    } else {
      // Unknown tab — create a fresh entry.
      try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        tabStates[activeInfo.tabId] = {
          tabId: activeInfo.tabId,
          windowId: activeInfo.windowId,
          url: tab.url ?? '',
          title: tab.title ?? '',
          favIconUrl: tab.favIconUrl ?? '',
          lastActiveAt: Date.now(),
          discardedAt: null,
          hasDirtyForm: false,
          isPinned: tab.pinned ?? false,
          isAudible: tab.audible ?? false,
        };
        await saveStorage({ tabStates });
      } catch {
        // Tab may have been removed between events.
      }
    }
  } catch {
    // Storage access may fail during shutdown.
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    const { tabStates } = await loadStorage();
    let state = tabStates[tabId];

    if (!state) {
      // First time seeing this tab.
      state = {
        tabId,
        windowId: tab.windowId,
        url: tab.url ?? '',
        title: tab.title ?? '',
        favIconUrl: tab.favIconUrl ?? '',
        lastActiveAt: Date.now(),
        discardedAt: null,
        hasDirtyForm: false,
        isPinned: tab.pinned ?? false,
        isAudible: tab.audible ?? false,
      };
      tabStates[tabId] = state;
    }

    // Track meaningful changes.
    if (changeInfo.url != null) {
      state.url = changeInfo.url;
      state.lastActiveAt = Date.now();
      state.discardedAt = null; // navigating means it is active again
    }
    if (changeInfo.title != null) state.title = changeInfo.title;
    if (changeInfo.favIconUrl != null) state.favIconUrl = changeInfo.favIconUrl;
    if (changeInfo.pinned != null) state.isPinned = changeInfo.pinned;
    if (changeInfo.audible != null) state.isAudible = changeInfo.audible;
    if (changeInfo.discarded === true) state.discardedAt = state.discardedAt ?? Date.now();
    if (changeInfo.discarded === false) state.discardedAt = null;

    await saveStorage({ tabStates });
  } catch {
    // Best-effort.
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const { tabStates } = await loadStorage();
    delete tabStates[tabId];
    await saveStorage({ tabStates });
    await updateBadge();
  } catch {
    // Best-effort cleanup.
  }
});

/* ── Startup / Install ────────────────────────────────── */

async function initializeAlarmAndState(): Promise<void> {
  // Ensure alarm exists.
  try {
    const existing = await chrome.alarms.get(ALARM_NAME);
    if (!existing) {
      await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
    }
  } catch {
    // Alarm API error — non-fatal.
  }

  // Reconcile stored tab states with actual open tabs.
  try {
    const openTabs = await chrome.tabs.query({});
    const { tabStates } = await loadStorage();
    const openIds = new Set<number>();

    for (const tab of openTabs) {
      if (tab.id == null) continue;
      openIds.add(tab.id);

      if (!tabStates[tab.id]) {
        tabStates[tab.id] = {
          tabId: tab.id,
          windowId: tab.windowId,
          url: tab.url ?? '',
          title: tab.title ?? '',
          favIconUrl: tab.favIconUrl ?? '',
          lastActiveAt: Date.now(),
          discardedAt: tab.discarded ? Date.now() : null,
          hasDirtyForm: false,
          isPinned: tab.pinned ?? false,
          isAudible: tab.audible ?? false,
        };
      }
    }

    // Remove stale entries for tabs that no longer exist.
    for (const idStr of Object.keys(tabStates)) {
      if (!openIds.has(Number(idStr))) {
        delete tabStates[Number(idStr)];
      }
    }

    await saveStorage({ tabStates });
  } catch {
    // Best-effort reconciliation.
  }

  await updateBadge();
}

chrome.runtime.onInstalled.addListener(() => {
  initializeAlarmAndState();
});

chrome.runtime.onStartup.addListener(() => {
  initializeAlarmAndState();
});

/* ── Alarm Handler ────────────────────────────────────── */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runSuspensionCheck();
  }
});

/* ── Message Handler ──────────────────────────────────── */

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    // We must return `true` to keep the sendResponse channel open for async work.
    handleMessage(message, sender)
      .then(sendResponse)
      .catch(() => sendResponse({ error: 'Internal error' }));
    return true;
  },
);

async function handleMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (message.type) {
    /* ── Stats ─────────────────────────────── */
    case 'GET_STATS': {
      const { tabStates, totalTabsSuspended, totalRamSavedMB } = await loadStorage();
      const sleepingCount = Object.values(tabStates).filter(
        (s) => s.discardedAt != null,
      ).length;
      return {
        sleepingCount,
        totalTabsSuspended,
        totalRamSavedMB,
        tabStates,
      };
    }

    /* ── Suspend a specific tab ───────────── */
    case 'SUSPEND_TAB': {
      const { tabId } = message.payload as { tabId: number };
      const { settings, tabStates, totalTabsSuspended, totalRamSavedMB } =
        await loadStorage();
      const state = tabStates[tabId];
      if (!state) return { success: false, reason: 'Tab not tracked' };

      if (settings.visualIndicators) await applyVisualDim(tabId);

      const ok = await suspendTab(tabId, state, settings.usePlaceholderPage);
      if (ok) {
        state.discardedAt = Date.now();
        await saveStorage({
          tabStates,
          totalTabsSuspended: totalTabsSuspended + 1,
          totalRamSavedMB: totalRamSavedMB + RAM_PER_TAB_MB,
        });
        await updateBadge();
      }
      return { success: ok };
    }

    /* ── Restore a suspended tab ──────────── */
    case 'RESTORE_TAB': {
      const { tabId } = message.payload as { tabId: number };
      try {
        const tab = await chrome.tabs.get(tabId);
        // If on placeholder page, extract original URL and navigate back.
        if (tab.url && tab.url.includes(chrome.runtime.getURL('suspended.html'))) {
          const params = new URL(tab.url).searchParams;
          const originalUrl = params.get('url');
          if (originalUrl) {
            await chrome.tabs.update(tabId, { url: originalUrl });
          }
        } else {
          // Natively discarded — just reload.
          await chrome.tabs.reload(tabId);
        }
        const { tabStates } = await loadStorage();
        if (tabStates[tabId]) {
          tabStates[tabId].discardedAt = null;
          tabStates[tabId].lastActiveAt = Date.now();
          await saveStorage({ tabStates });
        }
        await updateBadge();
        return { success: true };
      } catch {
        return { success: false, reason: 'Tab not found' };
      }
    }

    /* ── Suspend all except the active tab ── */
    case 'SUSPEND_ALL_OTHER': {
      const activeIds = await getActiveTabIds();
      const { settings, tabStates, totalTabsSuspended, totalRamSavedMB } =
        await loadStorage();
      let count = 0;

      for (const [idStr, state] of Object.entries(tabStates)) {
        const tabId = Number(idStr);
        if (activeIds.has(tabId)) continue;
        if (state.discardedAt != null) continue;
        if (isIgnoredUrl(state.url)) continue;

        if (settings.visualIndicators) await applyVisualDim(tabId);

        const ok = await suspendTab(tabId, state, settings.usePlaceholderPage);
        if (ok) {
          state.discardedAt = Date.now();
          count++;
        }
      }

      await saveStorage({
        tabStates,
        totalTabsSuspended: totalTabsSuspended + count,
        totalRamSavedMB: totalRamSavedMB + count * RAM_PER_TAB_MB,
      });
      await updateBadge();
      return { suspended: count };
    }

    /* ── Whitelist toggle ─────────────────── */
    case 'TOGGLE_WHITELIST': {
      const { domain } = message.payload as { domain: string };
      const { whitelist } = await loadStorage();
      const idx = whitelist.indexOf(domain);
      if (idx >= 0) {
        whitelist.splice(idx, 1);
      } else {
        whitelist.push(domain);
      }
      await saveStorage({ whitelist });
      return { whitelist };
    }

    /* ── Settings ─────────────────────────── */
    case 'GET_SETTINGS': {
      const { settings } = await loadStorage();
      return { settings };
    }

    case 'UPDATE_SETTINGS': {
      const incoming = message.payload as Partial<ExtensionSettings>;
      const { settings } = await loadStorage();
      const merged = { ...settings, ...incoming };
      await saveStorage({ settings: merged });
      return { settings: merged };
    }

    /* ── Content-script: dirty form flag ──── */
    case 'SET_DIRTY_FORM': {
      const { tabId: dirtyTabId, hasDirtyForm } = message.payload as {
        tabId?: number;
        hasDirtyForm: boolean;
      };
      const resolvedTabId = dirtyTabId ?? sender.tab?.id;
      if (resolvedTabId == null) return { success: false };

      const { tabStates } = await loadStorage();
      if (tabStates[resolvedTabId]) {
        tabStates[resolvedTabId].hasDirtyForm = hasDirtyForm;
        await saveStorage({ tabStates });
      }
      return { success: true };
    }

    /* ── Visual dim passthrough ───────────── */
    case 'APPLY_VISUAL_DIM': {
      const { tabId: dimTabId } = message.payload as { tabId: number };
      await applyVisualDim(dimTabId);
      return { success: true };
    }

    /* ── Tab state query (for popup/content) */
    case 'GET_TAB_STATE': {
      const { tabId: queryTabId } = message.payload as { tabId: number };
      const { tabStates } = await loadStorage();
      return { tabState: tabStates[queryTabId] ?? null };
    }

    default:
      return { error: `Unknown message type: ${(message as any).type}` };
  }
}

})();
