// The window's chrome with the custom title bar: the caption buttons (minimize, maximize,
// close), the maximized / focused state, the top resize edge, and `appearance.titleBar` applied
// live. Windows 11 Snap Layouts come from a native overlay over the buttons
// (src-tauri/src/titlebar.rs); the page draws them and shows the state the overlay reports.
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useChrome } from '../store/chrome';
import { useSettings } from '../store/settings';
import { useWorkspace } from '../store/workspace';
import { tabTitle } from '../store/workspaceModel';
import { initSettings } from './settingsSync';
import { setTitleBar, titlebarListen } from './settingsApi';
import { throttleLatest } from './throttle';

const win = () => getCurrentWindow();
const warn = (what: string) => (error: unknown) => console.warn(`[brisa] ${what}`, error);

export const minimizeWindow = () => void win().minimize().catch(warn('no se pudo minimizar'));
export const toggleMaximizeWindow = () => void win().toggleMaximize().catch(warn('no se pudo maximizar'));
export const closeWindow = () => void win().close().catch(warn('no se pudo cerrar'));
/** The top edge (the title bar covers it): resize from there like any other edge. */
export const startResizeTop = () => void win().startResizeDragging('North').catch(warn('no se pudo redimensionar'));

const APP_NAME = 'Brisa';
/** The taskbar does not need an agent's spinner at 20 frames per second. */
const WINDOW_TITLE_MS = 500;

/**
 * The window's title follows the active tab (custom name, or what the process sets via OSC
 * 0/2). Outside React on purpose: as a selector in App, every title change of an agent
 * re-rendered the whole app (measured: the biggest cost of two agents drawing).
 */
export function installWindowTitle(): () => void {
  let current: string | null = null;
  const apply = throttleLatest((title: string) => void win().setTitle(title).catch(() => {}), WINDOW_TITLE_MS);
  const update = () => {
    const s = useWorkspace.getState();
    const title = (s.activeTabId ? tabTitle(s, s.activeTabId, '') : '').trim() || APP_NAME;
    if (title === current) return;
    current = title;
    apply(title);
  };
  update();
  const unsubscribe = useWorkspace.subscribe(update);
  return () => {
    unsubscribe();
    apply.cancel();
  };
}

/** Follows the window and the setting; returns the uninstaller. */
export function installWindowChrome(): () => void {
  let disposed = false;
  const unlisten: (() => void)[] = [];
  const refreshMaximized = () =>
    void win()
      .isMaximized()
      .then((maximized) => useChrome.setState({ maximized }))
      .catch(() => {});
  refreshMaximized();
  void win()
    .onResized(refreshMaximized)
    .then((fn) => (disposed ? fn() : unlisten.push(fn)));
  const onFocus = () => useChrome.setState({ active: true });
  const onBlur = () => useChrome.setState({ active: false });
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  void titlebarListen((caption) => useChrome.setState({ caption })).catch(warn('titlebar_listen'));

  // appearance.titleBar, live (the window was created with the value read by the backend).
  const apply = () => {
    const s = useSettings.getState();
    if (!s.loaded) return;
    const native = s.settings.appearance.titleBar === 'native';
    if (native === useChrome.getState().nativeTitleBar) return;
    useChrome.setState({ nativeTitleBar: native });
    void setTitleBar(!native).catch(warn('no se pudo cambiar la barra de título'));
  };
  void initSettings().then(apply);
  const unsubscribe = useSettings.subscribe(apply);
  return () => {
    disposed = true;
    unlisten.forEach((fn) => fn());
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    unsubscribe();
  };
}
