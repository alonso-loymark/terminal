/// <reference types="vite/client" />
import type { Terminal } from '@xterm/xterm';

declare global {
  interface Window {
    /** Dev builds only: the live xterm instance, for debugging and end-to-end checks. */
    __terminal?: Terminal;
  }
}
