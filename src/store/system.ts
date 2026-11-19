import { create } from 'zustand';
import type { DetectedShell } from '../config/profiles';
import { getSystemInfo } from '../lib/pty';

/** Facts about the machine, asked to the backend once: home folder and the shells found. */
interface SystemState {
  homeDir: string | null;
  shells: DetectedShell[];
  loaded: boolean;
}

export const useSystem = create<SystemState>()(() => ({ homeDir: null, shells: [], loaded: false }));

let loading: Promise<void> | null = null;

export function loadSystemInfo(): Promise<void> {
  return (loading ??= getSystemInfo()
    .then((info) => useSystem.setState({ homeDir: info.homeDir, shells: info.shells, loaded: true }))
    .catch((error: unknown) => {
      console.warn('[terminal] system_info falló', error);
      useSystem.setState({ loaded: true });
    }));
}
