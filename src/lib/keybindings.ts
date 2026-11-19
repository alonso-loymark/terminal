import type { Terminal } from '@xterm/xterm';
import { copyText } from './clipboard';

/** Copies the selection (if any) and clears it, like Windows Terminal. */
export function copySelection(term: Terminal): void {
  const text = term.getSelection();
  if (!text) return;
  void copyText(text);
  term.clearSelection();
}
