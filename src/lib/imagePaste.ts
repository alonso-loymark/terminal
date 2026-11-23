// Images into a terminal: the clipboard's (Ctrl+V and every other paste gesture) and the ones
// dropped from a browser or another app. Text pastes as always; an image (and no text) goes to
// the agent as its own key, so it reads the clipboard itself, or is saved as a PNG whose path is
// pasted, as `terminal.imagePaste` says (see imagePasteModel.ts).
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import type { AgentName, PaneId } from '../store/workspaceModel';
import { readClipboard } from './clipboard';
import { savePastedImage, takeDroppedImage } from './fsApi';
import { imagePastePlan, imagePathText, isImageType, isPng, type ImagePasteMode } from './imagePasteModel';
import { sessionAgents } from './pty';
import { getPane } from './terminalRegistry';

const ws = () => useWorkspace.getState();
const toast = (message: string, kind: 'info' | 'warning' = 'info') => useUi.getState().showToast(message, kind);

/** A pane that can take input right now. */
function livePane(paneId: PaneId) {
  const pane = ws().panes[paneId];
  const handle = getPane(paneId);
  return pane && handle && pane.status === 'running' && pane.sessionId !== null ? { pane, handle } : null;
}

/** The agent running in the pane right now: asked to the backend (the monitor may be off or late). */
async function agentIn(paneId: PaneId): Promise<AgentName | null> {
  const pane = ws().panes[paneId];
  if (pane?.sessionId == null) return null;
  try {
    const [found] = await sessionAgents([pane.sessionId]);
    return found?.agent ?? null;
  } catch {
    return pane.agent && pane.agent.state !== 'finished' ? pane.agent.name : null;
  }
}

/** The image as PNG bytes: as is if it already is one, otherwise drawn and encoded (JPEG, WebP, BMP...). */
async function toPng(image: Blob): Promise<Uint8Array> {
  const bytes = new Uint8Array(await image.arrayBuffer());
  if (isPng(bytes)) return bytes;
  const bitmap = await createImageBitmap(image);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no hay canvas 2D');
    context.drawImage(bitmap, 0, 0);
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/**
 * An image for the pane. `asFile`: always saved and pasted as a path ("Pegar imagen como archivo",
 * drops); otherwise as the settings say (the agent's key only makes sense for the clipboard's).
 */
async function pasteImage(paneId: PaneId, image: () => Promise<Blob>, asFile: boolean): Promise<void> {
  if (!livePane(paneId)) {
    toast('Ese panel no tiene un programa en ejecución.', 'warning');
    return;
  }
  try {
    const agent = await agentIn(paneId);
    const mode: ImagePasteMode = asFile ? 'path' : useSettings.getState().settings.terminal.imagePaste;
    const plan = imagePastePlan(mode, agent);
    if (plan.kind === 'key') {
      // Through the input queue, like any key: it keeps its place among them.
      livePane(paneId)?.handle.session.sendText(plan.data);
      return;
    }
    const path = await savePastedImage(await toPng(await image()));
    const live = livePane(paneId);
    if (!live) return;
    live.handle.term.paste(imagePathText(path, agent, live.pane.shell));
  } catch (error) {
    console.warn('[brisa] no se pudo pegar la imagen', error);
    toast(`No se pudo pegar la imagen: ${error instanceof Error ? error.message : String(error)}`, 'warning');
  }
}

/** The paste gestures that are not the browser's own: right click, the menus, the palette, a custom shortcut. */
export async function pasteClipboard(paneId: PaneId): Promise<void> {
  const term = getPane(paneId)?.term;
  if (!term) return;
  const { text, image } = await readClipboard();
  if (text) term.paste(text);
  else if (image) await pasteImage(paneId, image, false);
}

/** "Pegar imagen como archivo": saved and pasted as a path, also with an agent or with text alongside. */
export async function pasteClipboardImageAsFile(paneId: PaneId): Promise<void> {
  const { image } = await readClipboard();
  if (!image) {
    toast('No hay una imagen en el portapapeles.');
    return;
  }
  await pasteImage(paneId, image, true);
}

/** An image dropped on a pane from a browser or another app: saved and pasted like the clipboard's. */
export async function dropImage(paneId: PaneId, id: number): Promise<void> {
  try {
    const bytes = await takeDroppedImage(id);
    ws().focusPane(paneId);
    getPane(paneId)?.term.focus();
    await pasteImage(paneId, async () => new Blob([bytes.slice().buffer]), true);
  } catch (error) {
    console.warn('[brisa] no se pudo soltar la imagen', error);
    toast(`No se pudo pegar la imagen: ${error instanceof Error ? error.message : String(error)}`, 'warning');
  }
}

/**
 * Ctrl+V, Ctrl+Shift+V, Shift+Insert: the browser fires `paste` and xterm pastes its text. With
 * an image and no text, xterm would paste nothing (and the program never sees the key): Brisa
 * takes it before xterm does. Returns the uninstaller.
 */
export function installImagePaste(): () => void {
  const onPaste = (event: ClipboardEvent) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.xterm')) return;
    const paneId = target.closest<HTMLElement>('.terminal-pane[data-pane-id]')?.dataset.paneId;
    const data = event.clipboardData;
    if (!paneId || !data || data.getData('text/plain')) return;
    const file = [...data.items].find((item) => item.kind === 'file' && isImageType(item.type))?.getAsFile();
    if (!file) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void pasteImage(paneId, async () => file, false);
  };
  window.addEventListener('paste', onPaste, { capture: true });
  return () => window.removeEventListener('paste', onPaste, { capture: true });
}
