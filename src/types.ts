/**
 * TabSaver Pro — Shared TypeScript Interfaces & Constants
 * ========================================================
 * With "module": "None" in tsconfig, all declarations are global.
 * Each compiled JS file is loaded independently by Chrome, so every
 * file that needs these values must redeclare them (or we inline).
 *
 * This file exists purely for TypeScript type-checking. It is NOT
 * loaded at runtime. Each script file declares its own constants.
 */

/* ── Tab Tracking ────────────────────────────────────── */

interface TabState {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  favIconUrl: string;
  lastActiveAt: number;
  discardedAt: number | null;
  hasDirtyForm: boolean;
  isPinned: boolean;
  isAudible: boolean;
}

/* ── Extension Settings ──────────────────────────────── */

interface ExtensionSettings {
  inactivityMinutes: number;
  neverSuspendAudible: boolean;
  neverSuspendPinned: boolean;
  neverSuspendDirtyForms: boolean;
  onlyOnBattery: boolean;
  usePlaceholderPage: boolean;
  visualIndicators: boolean;
}

/* ── Persistent Storage Schema ───────────────────────── */

interface StorageSchema {
  settings: ExtensionSettings;
  tabStates: Record<number, TabState>;
  whitelist: string[];
  totalTabsSuspended: number;
  totalRamSavedMB: number;
}

/* ── Messages between background ↔ content ↔ popup ──── */

type MessageType =
  | 'GET_TAB_STATE'
  | 'SET_DIRTY_FORM'
  | 'SUSPEND_TAB'
  | 'RESTORE_TAB'
  | 'SUSPEND_ALL_OTHER'
  | 'GET_STATS'
  | 'STATS_UPDATE'
  | 'TOGGLE_WHITELIST'
  | 'GET_SETTINGS'
  | 'UPDATE_SETTINGS'
  | 'APPLY_VISUAL_DIM';

interface ExtensionMessage {
  type: MessageType;
  payload?: unknown;
}

/* ── Constants (concrete values in each script's IIFE) ─ */
