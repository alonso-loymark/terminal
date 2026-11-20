// What the block menu does, and the blocks API for other modules (Fase 7B uses `blockText` as
// the context it gives the AI: command, output, exit code and folder of a block).
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import type { PaneId } from '../store/workspaceModel';
import type { BlockInfo, BlockText } from './blocks';
import { copyText } from './clipboard';
import { focusActiveTerminal } from './tabActions';
import { getPane } from './terminalRegistry';

/** The pane's finished blocks, oldest first (those still in its scrollback). */
export const paneBlocks = (paneId: PaneId): BlockInfo[] => getPane(paneId)?.blocks.list() ?? [];

/** One block with its output; null if it is gone (scrolled out of the scrollback). */
export const blockText = (paneId: PaneId, blockId: number): BlockText | null => getPane(paneId)?.blocks.text(blockId) ?? null;

/** The block selected with Ctrl+↑ / Ctrl+↓, if any. */
export const selectedBlock = (paneId: PaneId): number | null => getPane(paneId)?.blocks.selected ?? null;

/** Ctrl+↑ / Ctrl+↓. False when there is nothing to move to (the key goes on to the program). */
export const navigateBlocks = (paneId: PaneId, delta: -1 | 1): boolean => getPane(paneId)?.blocks.navigate(delta) ?? false;

export type BlockPart = 'command' | 'output' | 'both';

export async function copyBlock(paneId: PaneId, blockId: number, part: BlockPart): Promise<void> {
  const block = blockText(paneId, blockId);
  if (!block) {
    useUi.getState().showToast('Ese bloque ya no está en el historial de la terminal.', 'warning');
    return;
  }
  const text = part === 'command' ? block.command : part === 'output' ? block.output : `${block.command}\n${block.output}`;
  await copyText(text);
}

/**
 * Runs the block's command again in its pane: typed and run if the shell is idle at an empty
 * prompt; only inserted (not run) if something is typed there; nothing while a command runs.
 */
export function rerunBlock(paneId: PaneId, blockId: number): void {
  const block = blockText(paneId, blockId);
  const handle = getPane(paneId);
  const pane = useWorkspace.getState().panes[paneId];
  if (!block || !handle || !pane) return;
  if (pane.commandRunning || pane.status !== 'running') {
    useUi.getState().showToast('Hay un comando en ejecución en ese panel: no se escribe nada.', 'warning');
    return;
  }
  useWorkspace.getState().focusPane(paneId);
  const typed = handle.integration.promptInput();
  if (typed === '') handle.session.sendText(`${block.command}\r`);
  else handle.term.paste(block.command);
  focusActiveTerminal();
}
