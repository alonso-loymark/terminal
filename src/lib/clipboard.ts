/** Copies text to the system clipboard. Returns false if every method failed. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return legacyCopy(text);
  }
}

/** Reads text from the clipboard, or `null` if the webview refuses. */
export async function readText(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

function legacyCopy(text: string): boolean {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } finally {
    area.remove();
    previousFocus?.focus();
  }
}
