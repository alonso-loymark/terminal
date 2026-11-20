// Shell integration: turns the OSC sequences written by the scripts in
// src-tauri/resources/shell-integration into events. Parsing is pure (no runtime imports), so
// `node --test` covers it; `registerShellIntegration` wires it into an xterm instance.
//
// Protocol (same marks as VS Code and Windows Terminal):
//   OSC 7 ; file://<host>/<percent-encoded path>      current folder, at every prompt
//   OSC 133 ; A / B / C / D;<exit code>               prompt start / end, command start / end
//   OSC 633 ; E ; <command line, VS Code escaping>    the command about to run
//   OSC 633 ; P ; Shell=<name> | IntegrationError=<message>   loaded / failed to load
import type { IDisposable, IMarker, Terminal } from '@xterm/xterm';
import type { ShellEvent } from '../store/workspaceModel';

export type { ShellEvent };

/**
 * file://host/C:/Users/Ana%20Mar%C3%ADa → C:\Users\Ana María. Without a drive the host is a
 * UNC server: file://server/share/dir → \\server\share\dir. Anything else: null.
 */
export function cwdFromFileUri(uri: string): string | null {
  const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri.trim());
  if (!match) return null;
  let path: string;
  try {
    path = decodeURIComponent(match[2] ?? '/');
  } catch {
    return null;
  }
  const drive = /^\/([A-Za-z]):(\/.*)?$/.exec(path);
  if (drive) return `${drive[1]!.toUpperCase()}:${(drive[2] ?? '/').replace(/\//g, '\\')}`;
  const host = match[1] ?? '';
  if (!host || host.toLowerCase() === 'localhost') return null;
  return `\\\\${host}${path.replace(/\//g, '\\')}`.replace(/\\$/, '');
}

/**
 * OSC 9;9 (ConEmu / Windows Terminal, what cmd's prompt sends): `9;C:\path`, maybe quoted.
 * Other OSC 9 payloads (notifications, progress) are not a folder: null.
 */
export function cwdFromOsc9(data: string): string | null {
  if (!data.startsWith('9;')) return null;
  const path = data.slice(2).trim().replace(/^"(.*)"$/, '$1');
  return /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(path) || /^[A-Za-z]:$/.test(path) ? path.replace(/^([a-z]):/, (d) => d.toUpperCase()) : null;
}

/** Reverses VS Code's OSC 633 escaping: \\ and \xHH. */
export function unescapeOsc633(value: string): string {
  return value.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_, escaped: string, hex: string | undefined) =>
    hex ? String.fromCharCode(Number.parseInt(hex, 16)) : escaped,
  );
}

/** OSC 133 payload (without the number): A, B, C, D[;code]. B carries nothing we need. */
export function parseOsc133(data: string): ShellEvent | null {
  const [kind, code] = data.split(';');
  switch (kind) {
    case 'A':
      return { type: 'prompt' };
    case 'C':
      return { type: 'commandStart' };
    case 'D': {
      const exitCode = code !== undefined && /^-?\d+$/.test(code) ? Number(code) : null;
      return { type: 'commandEnd', exitCode };
    }
    default:
      return null;
  }
}

/** OSC 633 payload: E;<command line> or P;Key=Value. */
export function parseOsc633(data: string): ShellEvent | null {
  const at = data.indexOf(';');
  const kind = at < 0 ? data : data.slice(0, at);
  const rest = at < 0 ? '' : data.slice(at + 1);
  if (kind === 'E') {
    // VS Code may append ";<nonce>"; the command line itself has its semicolons escaped.
    return { type: 'commandLine', commandLine: unescapeOsc633(rest.split(';')[0] ?? '') };
  }
  if (kind === 'P') {
    const eq = rest.indexOf('=');
    const key = eq < 0 ? rest : rest.slice(0, eq);
    const value = eq < 0 ? '' : rest.slice(eq + 1);
    if (key === 'Shell') return { type: 'integration', ok: true };
    if (key === 'IntegrationError') return { type: 'integration', ok: false, error: value.trim() };
  }
  return null;
}

export interface ShellIntegrationHandle extends IDisposable {
  /**
   * What is typed after the current prompt (from the 133;B mark to the end of the input), or
   * null when unknown (no mark yet, a command is running). Lets the app refuse to type a
   * command over something the user left half-written.
   */
  promptInput(): string | null;
}

/** A notification a program asked the terminal to show (OSC 9 / OSC 777). */
export interface TerminalNotification {
  source: 'osc9' | 'osc777';
  title: string | null;
  body: string;
}

/**
 * OSC 9 ; <message> (iTerm2, Windows Terminal, Codex): a notification. ConEmu uses OSC 9 with
 * a number for other things (9;9 folder, 9;4 progress...): those are not.
 */
export function notificationFromOsc9(data: string): TerminalNotification | null {
  if (/^\d+(;|$)/.test(data)) return null;
  const body = data.trim();
  return body ? { source: 'osc9', title: null, body } : null;
}

/** OSC 777 ; notify ; <title> ; <body> (urxvt, Ghostty, foot). Other 777 commands: null. */
export function notificationFromOsc777(data: string): TerminalNotification | null {
  const [command, title = '', ...rest] = data.split(';');
  if (command !== 'notify') return null;
  const body = rest.join(';').trim();
  if (!title.trim() && !body) return null;
  return { source: 'osc777', title: title.trim() || null, body };
}

export interface ShellIntegrationHooks {
  /** The prompt has been drawn (133;B): the moment a command can be typed. */
  onInputStart?: () => void;
  /** A program asked for a notification (OSC 9 / OSC 777). */
  onNotify?: (notification: TerminalNotification) => void;
}

/** Registers the OSC handlers on a terminal; events go to `emit`. */
export function registerShellIntegration(
  term: Terminal,
  emit: (event: ShellEvent) => void,
  hooks: ShellIntegrationHooks = {},
): ShellIntegrationHandle {
  const { onInputStart, onNotify } = hooks;
  // Where the input starts: the cursor when the prompt-end mark arrives.
  let inputStart: { marker: IMarker; x: number } | null = null;
  const clearInput = () => {
    inputStart?.marker.dispose();
    inputStart = null;
  };
  const handle = (parse: (data: string) => ShellEvent | null) => (data: string) => {
    const event = parse(data);
    if (event) emit(event);
    return true; // handled: nothing else should act on these
  };
  const disposables = [
    term.parser.registerOscHandler(7, handle((data) => {
      const cwd = cwdFromFileUri(data);
      return cwd ? { type: 'cwd', cwd } : null;
    })),
    term.parser.registerOscHandler(133, (data) => {
      if (data === 'B') {
        clearInput();
        const marker = term.registerMarker(0);
        if (marker) inputStart = { marker, x: term.buffer.active.cursorX };
        if (onInputStart) queueMicrotask(onInputStart);
      } else if (data === 'C' || data.startsWith('D')) {
        clearInput();
      }
      return handle(parseOsc133)(data);
    }),
    term.parser.registerOscHandler(633, handle(parseOsc633)),
    // cmd's prompt reports the folder this way (see src-tauri/src/pty/shell.rs); a plain
    // message is a notification. ConEmu's other commands (progress...) are left alone.
    term.parser.registerOscHandler(9, (data) => {
      const cwd = cwdFromOsc9(data);
      if (cwd) {
        emit({ type: 'cwd', cwd });
        return true;
      }
      const notification = notificationFromOsc9(data);
      if (notification) onNotify?.(notification);
      return notification !== null;
    }),
    term.parser.registerOscHandler(777, (data) => {
      const notification = notificationFromOsc777(data);
      if (notification) onNotify?.(notification);
      return notification !== null;
    }),
  ];
  return {
    promptInput() {
      const buffer = term.buffer.active;
      if (!inputStart || inputStart.marker.isDisposed || inputStart.marker.line < 0 || buffer.type !== 'normal') return null;
      const lastLine = buffer.baseY + buffer.cursorY;
      let text = '';
      for (let y = inputStart.marker.line; y <= lastLine; y++) {
        const line = buffer.getLine(y)?.translateToString(true) ?? '';
        text += y === inputStart.marker.line ? line.slice(inputStart.x) : line;
      }
      return text;
    },
    dispose() {
      clearInput();
      disposables.forEach((d) => d.dispose());
    },
  };
}
