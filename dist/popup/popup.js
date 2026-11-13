"use strict";
/**
 * TabSaver Pro — Popup Script
 * Handles UI interactions and messaging with the background service worker.
 */
(() => {
    /* Types are declared globally via types.ts (module: None). */
    const TIMER_PRESETS_POPUP = [5, 15, 30, 60, 0];
    const RAM_PER_TAB_MB_POPUP = 70;
    /* ── DOM References ─────────────────────────────────── */
    const statSleeping = document.getElementById('stat-sleeping');
    const statRam = document.getElementById('stat-ram');
    const progressFill = document.getElementById('progress-fill');
    const progressLabel = document.getElementById('progress-label');
    const btnSuspendAll = document.getElementById('btn-suspend-all');
    const btnSettings = document.getElementById('btn-settings');
    const toggleWhitelist = document.getElementById('toggle-whitelist');
    const whitelistHost = document.getElementById('whitelist-host');
    const tabListContainer = document.getElementById('tab-list-container');
    const tabListEmpty = document.getElementById('tab-list-empty');
    const timerPills = document.querySelectorAll('.timer-pill');
    let currentHostname = '';
    let currentSettings = null;
    /* ── Helpers ─────────────────────────────────────────── */
    function sendMessage(msg) {
        return chrome.runtime.sendMessage(msg);
    }
    function formatRam(mb) {
        if (mb >= 1024) {
            return `~${(mb / 1024).toFixed(1)} GB`;
        }
        return `~${mb} MB`;
    }
    function getDomain(url) {
        try {
            return new URL(url).hostname;
        }
        catch {
            return '';
        }
    }
    /* ── UI Updates ──────────────────────────────────────── */
    function updateStats(stats) {
        // Stat cards
        statSleeping.textContent = String(stats.sleepingCount);
        statRam.textContent = formatRam(stats.ramSavedMB);
        // Progress bar
        const total = stats.totalTabs || 1;
        const pct = Math.round((stats.sleepingCount / total) * 100);
        progressFill.style.width = `${pct}%`;
        progressLabel.textContent = `${pct}% suspended`;
        // Whitelist toggle state
        if (currentHostname) {
            const isWhitelisted = stats.whitelist.some((d) => d === currentHostname || (d.startsWith('*.') && currentHostname.endsWith(d.slice(1))));
            toggleWhitelist.setAttribute('aria-checked', String(isWhitelisted));
        }
        // Settings → timer pills
        if (stats.settings) {
            currentSettings = stats.settings;
            syncTimerPills(stats.settings.inactivityMinutes);
        }
        // Suspended tabs list
        renderTabList(stats.tabStates);
    }
    function syncTimerPills(minutes) {
        timerPills.forEach((pill) => {
            const val = Number(pill.dataset.minutes);
            pill.classList.toggle('active', val === minutes);
        });
    }
    function renderTabList(tabStates) {
        const suspended = Object.values(tabStates).filter((t) => t.discardedAt !== null);
        if (suspended.length === 0) {
            tabListEmpty.style.display = '';
            // Remove all tab items but keep the empty message
            const items = tabListContainer.querySelectorAll('.tab-item');
            items.forEach((el) => el.remove());
            return;
        }
        tabListEmpty.style.display = 'none';
        // Clear existing items
        const existing = tabListContainer.querySelectorAll('.tab-item');
        existing.forEach((el) => el.remove());
        suspended.forEach((tab) => {
            const item = document.createElement('div');
            item.className = 'tab-item';
            item.setAttribute('role', 'button');
            item.setAttribute('tabindex', '0');
            item.setAttribute('aria-label', `Restore: ${tab.title}`);
            const favicon = document.createElement('img');
            favicon.className = 'tab-item__favicon';
            favicon.src = tab.favIconUrl || 'chrome://favicon/size/16/' + tab.url;
            favicon.alt = '';
            favicon.width = 16;
            favicon.height = 16;
            const title = document.createElement('span');
            title.className = 'tab-item__title';
            title.textContent = tab.title || getDomain(tab.url) || 'Untitled';
            const closeBtn = document.createElement('button');
            closeBtn.className = 'tab-item__close';
            closeBtn.setAttribute('aria-label', `Close ${tab.title}`);
            closeBtn.textContent = '×';
            item.appendChild(favicon);
            item.appendChild(title);
            item.appendChild(closeBtn);
            // Click tab row → restore
            item.addEventListener('click', (e) => {
                if (e.target.closest('.tab-item__close'))
                    return;
                sendMessage({ type: 'RESTORE_TAB', payload: { tabId: tab.tabId } });
            });
            // Keyboard support
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    sendMessage({ type: 'RESTORE_TAB', payload: { tabId: tab.tabId } });
                }
            });
            // Click × → close tab
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                chrome.tabs.remove(tab.tabId);
                item.remove();
                // Check if list is now empty
                if (tabListContainer.querySelectorAll('.tab-item').length === 0) {
                    tabListEmpty.style.display = '';
                }
            });
            tabListContainer.appendChild(item);
        });
    }
    /* ── Event Wiring ────────────────────────────────────── */
    // Suspend all other tabs
    btnSuspendAll.addEventListener('click', () => {
        sendMessage({ type: 'SUSPEND_ALL_OTHER' });
    });
    // Settings gear
    btnSettings.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });
    // Whitelist toggle
    toggleWhitelist.addEventListener('click', () => {
        if (!currentHostname)
            return;
        const current = toggleWhitelist.getAttribute('aria-checked') === 'true';
        toggleWhitelist.setAttribute('aria-checked', String(!current));
        sendMessage({ type: 'TOGGLE_WHITELIST', payload: { domain: currentHostname } });
    });
    // Timer pills
    timerPills.forEach((pill) => {
        pill.addEventListener('click', () => {
            const minutes = Number(pill.dataset.minutes);
            syncTimerPills(minutes);
            sendMessage({
                type: 'UPDATE_SETTINGS',
                payload: { inactivityMinutes: minutes },
            });
        });
    });
    /* ── Initialization ──────────────────────────────────── */
    document.addEventListener('DOMContentLoaded', async () => {
        // Get current tab hostname for whitelist row
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (activeTab?.url) {
                currentHostname = getDomain(activeTab.url);
                whitelistHost.textContent = currentHostname || '—';
            }
        }
        catch {
            whitelistHost.textContent = '—';
        }
        // Request stats from background
        try {
            const response = await sendMessage({ type: 'GET_STATS' });
            if (response) {
                updateStats(response);
            }
        }
        catch {
            // Background may not be ready yet
        }
    });
    /* ── Live Updates ────────────────────────────────────── */
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'STATS_UPDATE' && message.payload) {
            updateStats(message.payload);
        }
    });
})();
//# sourceMappingURL=popup.js.map