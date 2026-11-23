// Context menu primitives (one small widget, so they share a file).
import { useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import {
  ChevronsDownUp,
  ClipboardPaste,
  Code,
  Columns2,
  Copy,
  CopyPlus,
  Equal,
  Eraser,
  FileBraces,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Layers,
  LayersMinus,
  LayersPlus,
  LayoutTemplate,
  Maximize2,
  MessageSquarePlus,
  Pencil,
  Plus,
  RotateCw,
  Rows2,
  Save,
  Search,
  Settings,
  Sparkles,
  SquareX,
  TextSearch,
  TextSelect,
  Trash2,
  Ungroup,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { COLOR_NAMES, TAB_COLORS } from '../config/colors';
import { COLORS, type TabColor } from '../store/workspaceModel';

/** Every menu action's icon, by its `action` (items that bring their own, like profiles, have none). */
const ICONS: Record<string, LucideIcon> = {
  rename: Pencil,
  'rename-group': Pencil,
  'rename-entry': Pencil,
  duplicate: CopyPlus,
  'new-group': LayersPlus,
  'move-to-group': Layers,
  'remove-from-group': LayersMinus,
  ungroup: Ungroup,
  'toggle-group': ChevronsDownUp,
  close: X,
  'close-others': SquareX,
  'close-group': X,
  'close-pane': X,
  'split-right': Columns2,
  'split-down': Rows2,
  'split-here': Columns2,
  'tab-here': Plus,
  zoom: Maximize2,
  equalize: Equal,
  copy: Copy,
  'copy-path': Copy,
  'copy-relative-path': Copy,
  'copy-command': Copy,
  'copy-output': Copy,
  'copy-both': Copy,
  paste: ClipboardPaste,
  'select-all': TextSelect,
  find: Search,
  clear: Eraser,
  rerun: RotateCw,
  'explain-block': Sparkles,
  'ai-attach': MessageSquarePlus,
  trash: Trash2,
  'new-file': FilePlus,
  'new-folder': FolderPlus,
  'open-vscode': Code,
  'open-file-manager': FolderOpen,
  'open-layout': LayoutTemplate,
  'save-tab-layout': Save,
  'save-window-layout': Save,
  'open-layouts-json': FileBraces,
  'open-palette': TextSearch,
  'open-settings': Settings,
  'open-orchestrator': Workflow,
  crumb: Folder,
};

interface MenuProps {
  x: number;
  y: number;
  label: string;
  onClose: () => void;
  children: ReactNode;
}

const items = (menu: HTMLElement) =>
  [...menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')];

/** Positioned at the pointer, kept inside the window; Escape/outside click closes; arrows move. */
export function Menu({ x, y, label, onClose, children }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
    items(menu)[0]?.focus();
  }, [x, y]);

  const onKeyDown = (event: KeyboardEvent) => {
    const menu = ref.current;
    if (!menu) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const list = items(menu);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : at + (event.key === 'ArrowDown' ? 1 : -1);
    list[(next + list.length) % list.length]?.focus();
  };

  return (
    <div
      className="menu-backdrop"
      onPointerDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        className="menu"
        style={position}
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}

interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  action: string;
  shortcut?: string;
  onSelect: () => void;
}

export function MenuItem({ action, shortcut, onSelect, children, ...rest }: MenuItemProps) {
  const Icon = ICONS[action];
  return (
    <button type="button" role="menuitem" className="menu-item" data-action={action} onClick={onSelect} {...rest}>
      {Icon && <Icon className="menu-item-icon" aria-hidden="true" />}
      <span className="menu-item-label">{children}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

export const MenuSeparator = () => <div role="separator" className="menu-separator" />;

export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu-label">{children}</div>;

interface ColorSwatchesProps {
  value: TabColor | null;
  allowNone?: boolean;
  onPick: (color: TabColor | null) => void;
}

export function ColorSwatches({ value, allowNone = false, onPick }: ColorSwatchesProps) {
  const options: (TabColor | null)[] = allowNone ? [null, ...COLORS] : [...COLORS];
  return (
    <div className="menu-swatches" role="group" aria-label="Color">
      {options.map((color) => (
        <button
          key={color ?? 'none'}
          type="button"
          role="menuitemradio"
          aria-checked={value === color}
          aria-label={color ? COLOR_NAMES[color] : 'Sin color'}
          title={color ? COLOR_NAMES[color] : 'Sin color'}
          className="swatch"
          data-color={color ?? 'none'}
          style={{ background: color ? TAB_COLORS[color] : undefined }}
          onClick={() => onPick(color)}
        />
      ))}
    </div>
  );
}
