"use strict";
/**
 * TabSaver Pro — Content Script
 * ==============================
 * Lightweight script injected into every page.
 * 1. Detects dirty (unsaved) form data and notifies the background service worker.
 * 2. Applies a visual "dimming" indicator (💤 title prefix) on request.
 */
(() => {
    /* Types are declared globally via types.ts (module: None). */
    /* ── Constants ──────────────────────────────────────────── */
    const DEBOUNCE_MS = 250;
    const FORM_SELECTORS = 'form, input, textarea, select, [contenteditable]';
    const DIRTY_PREFIX = '💤 ';
    /* ── State ──────────────────────────────────────────────── */
    let isDirty = false;
    let debounceTimer = null;
    let observer = null;
    /* ── Helpers ────────────────────────────────────────────── */
    /** Send dirty-form status to the background service worker. */
    function notifyDirty(dirty) {
        if (isDirty === dirty)
            return;
        isDirty = dirty;
        const message = {
            type: 'SET_DIRTY_FORM',
            payload: { tabId: undefined, isDirty: dirty },
        };
        try {
            chrome.runtime.sendMessage(message);
        }
        catch {
            // Extension context may have been invalidated (e.g. after update).
        }
    }
    /** Debounced handler for form-field mutation events. */
    function onFieldActivity() {
        if (debounceTimer !== null)
            clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            notifyDirty(true);
        }, DEBOUNCE_MS);
    }
    /** Handler for form submit / reset — clears dirty flag. */
    function onFormClean() {
        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        notifyDirty(false);
    }
    /* ── Listener Attachment ────────────────────────────────── */
    /**
     * Attach mutation-detecting listeners to a single element.
     * We use a WeakSet to avoid double-binding on the same node.
     */
    const boundElements = new WeakSet();
    function bindElement(el) {
        if (boundElements.has(el))
            return;
        boundElements.add(el);
        const tag = el.tagName;
        if (tag === 'FORM') {
            el.addEventListener('submit', onFormClean);
            el.addEventListener('reset', onFormClean);
            return;
        }
        // input / textarea / select / [contenteditable]
        el.addEventListener('input', onFieldActivity);
        el.addEventListener('change', onFieldActivity);
        el.addEventListener('keydown', onFieldActivity);
    }
    /** Scan the document for existing form elements and bind them. */
    function scanAndBind() {
        const elements = document.querySelectorAll(FORM_SELECTORS);
        elements.forEach(bindElement);
    }
    /* ── MutationObserver for dynamic elements ──────────────── */
    function startObserver() {
        observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE)
                        continue;
                    const el = node;
                    // Check the node itself
                    if (el.matches(FORM_SELECTORS)) {
                        bindElement(el);
                    }
                    // Check descendants
                    const descendants = el.querySelectorAll(FORM_SELECTORS);
                    descendants.forEach(bindElement);
                }
            }
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
    }
    /* ── Visual Dimming ─────────────────────────────────────── */
    function applyVisualDim() {
        if (!document.title.startsWith(DIRTY_PREFIX)) {
            document.title = DIRTY_PREFIX + document.title;
        }
    }
    /* ── Message Listener (from background) ─────────────────── */
    function onMessage(message, _sender, _sendResponse) {
        if (message.type === 'APPLY_VISUAL_DIM') {
            applyVisualDim();
        }
    }
    /* ── Cleanup ────────────────────────────────────────────── */
    function cleanup() {
        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        chrome.runtime.onMessage.removeListener(onMessage);
    }
    /* ── Initialisation ─────────────────────────────────────── */
    function init() {
        // Bind existing form elements
        scanAndBind();
        // Watch for dynamically added form elements
        startObserver();
        // Listen for messages from the background service worker
        chrome.runtime.onMessage.addListener(onMessage);
        // Clean up when the content-script's port disconnects (page unload / extension update)
        try {
            const port = chrome.runtime.connect({ name: 'content-script' });
            port.onDisconnect.addListener(cleanup);
        }
        catch {
            // Extension context may be unavailable; listeners will be GC'd with the page.
        }
    }
    init();
})();
//# sourceMappingURL=content.js.map