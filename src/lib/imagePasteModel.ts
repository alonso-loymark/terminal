// Pasting an image into a terminal: what to do with it (pure, covered by node --test in
// imagePasteModel.test.ts). The impure side, clipboard and IPC, is lib/imagePaste.ts.
//
// An AI agent reads the clipboard image itself when it gets its own key (in Windows, verified in
// each one's code): forwarding that key works like in VS Code. Otherwise Brisa saves the image as
// a PNG and pastes its path, quoted: the four agents take a pasted image path as an attachment,
// and a shell gets a path it can use.
import { quotePath } from './explorerModel.ts';
import type { AgentName, ShellKind } from '../store/workspaceModel';

/** settings.json `terminal.imagePaste`. */
export type ImagePasteMode = 'auto' | 'key' | 'path';

/**
 * The key each agent pastes a clipboard image on, in Windows:
 * - Claude Code: `chat:imagePaste` is Alt+V in Windows (Ctrl+V only in WSL, where the terminal
 *   takes it for text); an empty paste does not read the clipboard there.
 * - Codex: `fixed.paste_image` = Ctrl+V (and Ctrl+Alt+V).
 * - Gemini CLI: `input.paste` = Ctrl+V, Cmd+V or Alt+V (PowerShell reads the image).
 * - agy: Ctrl+V (Alt+V as an alternative in Windows).
 * Through ConPTY: Ctrl+V = 0x16, Alt+V = ESC v.
 */
export const IMAGE_PASTE_KEYS: Record<AgentName, { data: string; label: string }> = {
  claude: { data: '\x1bv', label: 'Alt+V' },
  codex: { data: '\x16', label: 'Ctrl+V' },
  gemini: { data: '\x16', label: 'Ctrl+V' },
  agy: { data: '\x16', label: 'Ctrl+V' },
};

/** Ctrl+V as a program reads it (raw mode). */
export const RAW_CTRL_V = '\x16';

export type ImagePastePlan = { kind: 'key'; data: string; label: string } | { kind: 'file' };

/**
 * auto: the agent's key if an agent runs, otherwise the image as a file; key: always a key (the
 * agent's, or a raw Ctrl+V for whatever program runs); path: always the file.
 */
export function imagePastePlan(mode: ImagePasteMode, agent: AgentName | null): ImagePastePlan {
  if (mode === 'path') return { kind: 'file' };
  if (agent) return { kind: 'key', ...IMAGE_PASTE_KEYS[agent] };
  return mode === 'key' ? { kind: 'key', data: RAW_CTRL_V, label: 'Ctrl+V' } : { kind: 'file' };
}

/**
 * How a saved image's path is typed (as a paste, with a space after it): the Windows path in
 * double quotes for an agent (the four strip the quotes and attach the image; Gemini turns it
 * into `@path`), the shell's own quoting otherwise (an MSYS path in Git Bash...).
 */
export function imagePathText(path: string, agent: AgentName | null, shell: ShellKind | null): string {
  return `${agent ? `"${path}"` : quotePath(path, shell)} `;
}

/** PNG signature: what the backend accepts as is. */
export function isPng(bytes: Uint8Array): boolean {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

/** The image types a clipboard or a drop can carry (anything the page can decode). */
export const isImageType = (type: string): boolean => type.startsWith('image/');
