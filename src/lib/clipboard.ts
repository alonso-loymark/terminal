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

export interface ClipboardContents {
  /** Its text, if it has any (null when empty). */
  text: string | null;
  /** Its image (an image and no text: a screenshot, "Copiar imagen"...), read on demand. */
  image: (() => Promise<Blob>) | null;
}

/**
 * What the clipboard holds, for the paste gestures that are not the browser's own (right click,
 * a menu, the palette). Chromium hands bitmaps over as PNG. Text only if the webview refuses.
 */
export async function readClipboard(): Promise<ClipboardContents> {
  try {
    const items = await navigator.clipboard.read();
    let text: string | null = null;
    let image: (() => Promise<Blob>) | null = null;
    for (const item of items) {
      if (text === null && item.types.includes('text/plain')) {
        text = (await (await item.getType('text/plain')).text()) || null;
      }
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!image && type) image = () => item.getType(type);
    }
    return { text, image };
  } catch {
    return { text: await readText(), image: null };
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
