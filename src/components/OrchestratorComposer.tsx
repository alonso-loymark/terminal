import { ImageIcon, SendHorizontal, Square, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { imagePreview, pastedImage, saveImageForAgent } from '../lib/imagePaste';
import { cancelBusy, openChat, sendMessage } from '../lib/orchestratorActions';
import { modelMention, type RankedModel } from '../lib/orchestratorModel';
import { useUi } from '../store/ui';
import type { PaneId } from '../store/workspaceModel';

/** The input grows with its text up to this height, then scrolls. */
const MAX_HEIGHT = 240;
const MAX_IMAGES = 8;

interface Props {
  paneId: PaneId;
  dir: string | null;
  models: RankedModel[];
  /** The input can be used (orchestrator on, project read). */
  ready: boolean;
  /** A task of this chat is running ("Detener"). */
  busyHere: boolean;
  /** Something else of the project runs (another chat; AGENTS.md: no chat): one thing at a time. */
  busyElsewhere: { chatId: string | null; title: string } | null;
}

/**
 * The orchestrator's input: multiline and growing, `@modelo` completion at the start, pasted
 * images (saved like the terminal's, sent to the worker with the brief) and "Detener" while a
 * task of this chat runs. Enter sends, Shift+Enter is a new line, Esc stops.
 */
export function OrchestratorComposer({ paneId, dir, models, ready, busyHere, busyElsewhere }: Props) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [saving, setSaving] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grows with the text (up to MAX_HEIGHT).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(MAX_HEIGHT, el.scrollHeight + 2)}px`;
    el.style.overflowY = el.scrollHeight + 2 > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  const mention = modelMention(text.slice(0, caret), models);
  const suggestions = mention && dismissed !== text.slice(0, caret) ? mention : null;
  const busy = busyHere || busyElsewhere !== null;

  const accept = (value: string) => {
    if (!mention) return;
    const rest = text.slice(caret).replace(/^\S*/, '');
    const head = `${text.slice(0, mention.start)}@${value} `;
    const next = `${head}${rest.replace(/^\s+/, '')}`;
    setText(next);
    setPick(0);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(head.length, head.length);
      setCaret(head.length);
    });
  };

  const send = () => {
    if (!dir || !text.trim() || busy || !ready || saving) return;
    const message = text;
    const attached = images;
    setText('');
    setImages([]);
    setCaret(0);
    void sendMessage(dir, message, attached);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (suggestions) {
      const n = suggestions.items.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setPick((p) => (p + (event.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        accept(suggestions.items[Math.min(pick, n - 1)] ?? suggestions.items[0] ?? '');
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(text.slice(0, caret));
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape' && busyHere && dir) {
      event.preventDefault();
      cancelBusy(dir);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const image = pastedImage(event.clipboardData);
    if (!image) return;
    event.preventDefault();
    if (images.length >= MAX_IMAGES) {
      useUi.getState().showToast(`Como mucho ${MAX_IMAGES} imágenes por mensaje.`, 'warning');
      return;
    }
    setSaving((n) => n + 1);
    saveImageForAgent(image)
      .then((path) => setImages((list) => (list.includes(path) ? list : [...list, path])))
      .catch((error: unknown) => useUi.getState().showToast(`No se pudo adjuntar la imagen: ${error instanceof Error ? error.message : String(error)}`, 'warning'))
      .finally(() => setSaving((n) => n - 1));
  };

  const placeholder = !ready
    ? 'El orquestador no está listo'
    : busyHere
      ? 'Trabajando… (Esc o «Detener» para parar)'
      : busyElsewhere
        ? busyElsewhere.chatId
          ? `Hay una tarea en curso en «${busyElsewhere.title}» (una a la vez por proyecto)`
          : 'Esperando a que termine el análisis de AGENTS.md'
        : 'Qué hay que hacer. @modelo al principio lo elige; Ctrl+V pega imágenes';

  return (
    <footer className="orch-composer">
      {(images.length > 0 || saving > 0) && (
        <div className="orch-attachments">
          {images.map((path) => {
            const src = imagePreview(path);
            return (
              <span key={path} className="orch-attachment" data-orch="attachment" title={path}>
                {src ? <img src={src} alt="Imagen adjunta" /> : <ImageIcon aria-hidden="true" />}
                <button type="button" aria-label="Quitar la imagen" data-action="orch-remove-image" onClick={() => setImages((list) => list.filter((p) => p !== path))}>
                  <X aria-hidden="true" />
                </button>
              </span>
            );
          })}
          {saving > 0 && <span className="orch-attachment orch-muted">Guardando…</span>}
        </div>
      )}
      <div className="orch-input-row">
        <div className="orch-input-wrap">
          {suggestions && (
            <ul className="orch-suggest" role="listbox" aria-label="Modelos" data-orch="model-suggest">
              {suggestions.items.map((value, i) => {
                const model = models.find((m) => m.value === value);
                return (
                  <li
                    key={value}
                    role="option"
                    aria-selected={i === pick}
                    data-value={value}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      accept(value);
                    }}
                  >
                    <strong>@{value}</strong>
                    {model && (
                      <span className="orch-muted">
                        {model.displayName} · {model.tier}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <textarea
            ref={ref}
            data-orch-input={paneId}
            rows={1}
            value={text}
            disabled={!ready}
            placeholder={placeholder}
            aria-label="Mensaje para el orquestador"
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setPick(0);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>
        {busyHere ? (
          <button type="button" className="orch-send danger" data-action="orch-stop" title="Detener la tarea (Esc)" onClick={() => dir && cancelBusy(dir)}>
            <Square aria-hidden="true" />
            Detener
          </button>
        ) : busyElsewhere?.chatId && dir ? (
          <button type="button" className="orch-send" data-action="orch-go-busy" title="Ir al chat que está trabajando" onClick={() => busyElsewhere.chatId && openChat(dir, busyElsewhere.chatId)}>
            Ir al chat
          </button>
        ) : (
          <button type="button" className="orch-send primary" data-action="orch-send" disabled={!text.trim() || !ready || saving > 0 || busy} title="Enviar (Enter)" onClick={send}>
            <SendHorizontal aria-hidden="true" />
            Enviar
          </button>
        )}
      </div>
    </footer>
  );
}
