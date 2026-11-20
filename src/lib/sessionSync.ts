// The session: at startup the tabs, groups and panes of last time come back (with their names,
// colors, sizes, profiles and folders; not their content); from then on every change is saved
// to session.json, a moment after it happens, atomically (temporary file + rename: a crash
// leaves the previous version, never half a file). `session.restore: false` in settings.json
// neither restores nor keeps the tabs. The palette's recent commands live there too.
import { parseSession, sessionToText, snapshotWindow, type SessionFile } from '../store/layoutModel';
import { useSession } from '../store/session';
import { useSettings } from '../store/settings';
import { loadSystemInfo } from '../store/system';
import { useWorkspace } from '../store/workspace';
import { initLayouts } from './layoutsSync';
import { readConfigFile, writeConfigFile } from './settingsApi';
import { initSettings } from './settingsSync';

/** Saving waits for changes to settle (a burst of prompts, a divider drag)... */
const SAVE_DELAY_MS = 250;
/** ...but not forever: a title changing every 100 ms must not hold the save back. */
const MAX_SAVE_DELAY_MS = 1000;

let started: Promise<void> | null = null;

/**
 * Loads settings, shells, layouts and the last session, and fills the workspace: restored, or one
 * fresh tab. Never rejects: whatever fails, the app starts with one tab.
 */
export function initSession(): Promise<void> {
  return (started ??= start());
}

async function readSession(): Promise<SessionFile> {
  try {
    const text = await readConfigFile('session');
    return parseSession(text ? JSON.parse(text) : null);
  } catch (error) {
    console.warn('[brisa] session.json ilegible: se empieza de cero', error);
    return parseSession(null);
  }
}

async function start(): Promise<void> {
  const [session] = await Promise.all([readSession(), initSettings(), loadSystemInfo()]);
  await initLayouts();
  const ws = useWorkspace.getState();
  try {
    if (useSettings.getState().settings.session.restore && session.window) ws.openWindow(session.window, { replace: true });
    else ws.reset();
  } catch (error) {
    console.warn('[brisa] no se pudo restaurar la sesión', error);
    ws.reset();
  }
  if (useWorkspace.getState().tabOrder.length === 0) ws.reset();
  useSession.setState({ recent: session.recent, ready: true });
  lastText = currentText();
  useWorkspace.subscribe(schedule);
  useSession.subscribe((s, prev) => s.recent !== prev.recent && schedule());
  useSettings.subscribe((s, prev) => s.settings.session !== prev.settings.session && schedule());
}

function currentText(): string {
  const restore = useSettings.getState().settings.session.restore;
  const ws = useWorkspace.getState();
  const saved = restore && ws.tabOrder.length ? snapshotWindow(ws, ws.tabOrder, { worktrees: true }) : null;
  return sessionToText({ version: 1, window: saved, recent: useSession.getState().recent });
}

let timer = 0;
let pendingSince = 0;
let lastText = '';
let writing: Promise<void> = Promise.resolve();

function schedule(): void {
  const now = Date.now();
  if (!pendingSince) pendingSince = now;
  window.clearTimeout(timer);
  const delay = Math.min(SAVE_DELAY_MS, Math.max(0, pendingSince + MAX_SAVE_DELAY_MS - now));
  timer = window.setTimeout(() => void flushSession(), delay);
}

/** Saves now if anything changed (also before the window closes with its last tab). */
export function flushSession(): Promise<void> {
  window.clearTimeout(timer);
  pendingSince = 0;
  if (!useSession.getState().ready) return writing;
  const text = currentText();
  if (text === lastText) return writing;
  lastText = text;
  // One write at a time, in order: the last one always wins.
  writing = writing
    .then(() => writeConfigFile('session', text))
    .catch((error: unknown) => console.warn('[brisa] no se pudo guardar la sesión', error));
  return writing;
}
