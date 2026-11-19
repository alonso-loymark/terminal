import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';
import { applyCachedTheme } from './lib/appearance';

const root = document.getElementById('root');
if (!root) throw new Error('#root no existe en index.html');

// The last theme, before anything paints (the settings file is read right after).
applyCachedTheme();

if (import.meta.env.DEV) void import('./lib/devHooks').then((hooks) => hooks.installDevHooks());

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
