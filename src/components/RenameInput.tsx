import { useEffect, useRef, type KeyboardEvent } from 'react';

interface RenameInputProps {
  initial: string;
  label: string;
  /** Enter or losing focus. */
  onCommit: (value: string) => void;
  /** Escape. */
  onCancel: () => void;
}

/** Inline editor for tab and group names. */
export function RenameInput({ initial, label, onCommit, onCancel }: RenameInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  // Enter/Escape unmount the input, which fires blur: settle only once.
  const settled = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const settle = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(ref.current?.value ?? '');
    else onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Keep keys away from the tab (drag & drop, click handlers).
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      settle(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      settle(false);
    }
  };

  return (
    <input
      ref={ref}
      className="rename-input"
      defaultValue={initial}
      aria-label={label}
      spellCheck={false}
      onKeyDown={onKeyDown}
      onBlur={() => settle(true)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}
