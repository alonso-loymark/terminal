// Form primitives of the settings screen (one small widget, so they share a file). Each control
// shows a value from the settings and writes changes through `onCommit`; text and numbers are
// committed on Enter or when the field loses the focus, not on every keystroke.
import { useEffect, useId, useState, type ReactNode } from 'react';

interface FieldProps {
  label: string;
  hint?: ReactNode;
  /** The settings path, for tests and for the user (shown as the JSON key in the tooltip). */
  setting?: string;
  children: (id: string) => ReactNode;
}

export function Field({ label, hint, setting, children }: FieldProps) {
  const id = useId();
  return (
    <div className="settings-field" data-setting={setting}>
      <label htmlFor={id} title={setting ? `settings.json: ${setting}` : undefined}>
        {label}
      </label>
      <div className="settings-control">
        {children(id)}
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
    </div>
  );
}

export function Toggle({ id, value, disabled, onCommit }: { id: string; value: boolean; disabled?: boolean; onCommit: (value: boolean) => void }) {
  return (
    <input
      id={id}
      type="checkbox"
      role="switch"
      className="settings-toggle"
      checked={value}
      disabled={disabled}
      onChange={(event) => onCommit(event.currentTarget.checked)}
    />
  );
}

interface NumberProps {
  id: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}

export function NumberInput({ id, value, min, max, step = 1, disabled, onCommit }: NumberProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Number(draft.replace(',', '.'));
    if (draft.trim() === '' || !Number.isFinite(next)) return setDraft(String(value));
    const clamped = Math.min(max, Math.max(min, step >= 1 ? Math.round(next) : next));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input
      id={id}
      type="number"
      className="settings-input settings-number"
      value={draft}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') setDraft(String(value));
      }}
      // Arrow keys and the spinner buttons step the value: apply it right away.
      onKeyUp={(event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') commit();
      }}
      onPointerUp={commit}
    />
  );
}

export function Range({ id, value, min, max, step = 1, disabled, onCommit }: NumberProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <span className="settings-range">
      <input
        id={id}
        type="range"
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => setDraft(Number(event.currentTarget.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <output htmlFor={id}>{draft}%</output>
    </span>
  );
}

export function Select<T extends string>({
  id,
  value,
  options,
  disabled,
  onCommit,
}: {
  id: string;
  value: T;
  options: readonly (readonly [T, string])[];
  disabled?: boolean;
  onCommit: (value: T) => void;
}) {
  return (
    <select
      id={id}
      className="settings-input settings-select"
      value={value}
      disabled={disabled}
      onChange={(event) => onCommit(event.currentTarget.value as T)}
    >
      {options.map(([option, label]) => (
        <option key={option} value={option}>
          {label}
        </option>
      ))}
    </select>
  );
}

interface TextProps {
  id: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  /** Suggestions (a datalist). */
  suggestions?: readonly string[];
  multiline?: boolean;
  onCommit: (value: string) => void;
}

export function TextInput({ id, value, placeholder, disabled, suggestions, multiline, onCommit }: TextProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  const listId = `${id}-list`;
  if (multiline) {
    return (
      <textarea
        id={id}
        className="settings-input settings-textarea"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        rows={Math.min(8, Math.max(2, draft.split('\n').length + 1))}
        spellCheck={false}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.ctrlKey) commit();
        }}
      />
    );
  }
  return (
    <>
      <input
        id={id}
        type="text"
        className="settings-input"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        list={suggestions ? listId : undefined}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(value);
        }}
      />
      {suggestions && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </>
  );
}
