import { Copy, Minus, Square, X } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { titlebarButtons, type CaptionButton } from '../lib/settingsApi';
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from '../lib/windowChrome';
import { useChrome } from '../store/chrome';

/**
 * Minimize, maximize / restore and close, at the right of the custom title bar. On Windows a
 * native overlay sits on top of them (Snap Layouts) and reports hover and press, which are
 * painted here; without it, the buttons handle the mouse themselves.
 */
export function WindowControls() {
  const ref = useRef<HTMLDivElement>(null);
  const maximized = useChrome((s) => s.maximized);
  const caption = useChrome((s) => s.caption);

  // Tell the backend where the buttons are: on layout changes and window resizes (they sit at
  // the right edge, so they move without changing size).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const report = () => {
      // Physical pixels: the page's own scale maps its CSS pixels to the screen.
      const r = el.getBoundingClientRect();
      const k = window.devicePixelRatio;
      void titlebarButtons({ x: r.left * k, y: r.top * k, width: r.width * k, height: r.height * k }).catch(() => {});
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(report);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    window.addEventListener('resize', schedule);
    report();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      void titlebarButtons(null).catch(() => {});
    };
  }, []);

  const state = (button: CaptionButton) =>
    caption.native ? { 'data-hover': caption.hover === button || undefined, 'data-pressed': caption.pressed === button || undefined } : {};

  return (
    <div ref={ref} className="window-controls" data-native={caption.native || undefined}>
      <button type="button" className="caption-button" data-button="minimize" tabIndex={-1} aria-label="Minimizar" title="Minimizar" onClick={minimizeWindow} {...state('minimize')}>
        <Minus aria-hidden="true" />
      </button>
      <button
        type="button"
        className="caption-button"
        data-button="maximize"
        tabIndex={-1}
        aria-label={maximized ? 'Restaurar' : 'Maximizar'}
        title={maximized ? 'Restaurar' : 'Maximizar'}
        onClick={toggleMaximizeWindow}
        {...state('maximize')}
      >
        {maximized ? <Copy aria-hidden="true" /> : <Square aria-hidden="true" />}
      </button>
      <button type="button" className="caption-button" data-button="close" tabIndex={-1} aria-label="Cerrar" title="Cerrar" onClick={closeWindow} {...state('close')}>
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
