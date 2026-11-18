import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CSSProperties, MouseEvent } from 'react';
import { TAB_COLORS } from '../config/colors';
import { focusActiveTerminal, requestCloseTabs } from '../lib/tabActions';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { tabIndicator, tabTitle, type TabId } from '../store/workspaceModel';
import { RenameInput } from './RenameInput';

const INDICATOR_LABEL = {
  activity: 'Salida nueva',
  exited: 'El proceso terminó',
  'exited-error': 'El proceso terminó con error',
} as const;

export function TabItem({ tabId }: { tabId: TabId }) {
  const title = useWorkspace((s) => tabTitle(s, tabId));
  const indicator = useWorkspace((s) => tabIndicator(s, tabId));
  const active = useWorkspace((s) => s.activeTabId === tabId);
  const color = useWorkspace((s) => s.tabs[tabId]?.color ?? null);
  const group = useWorkspace((s) => {
    const groupId = s.tabs[tabId]?.groupId;
    return groupId ? s.groups[groupId] : undefined;
  });
  const exitCode = useWorkspace((s) => s.panes[s.tabs[tabId]?.activePaneId ?? '']?.exitCode ?? null);
  const customTitle = useWorkspace((s) => s.tabs[tabId]?.customTitle ?? null);
  const renaming = useUi((s) => s.renamingTabId === tabId);
  // Not `disabled: renaming`: dnd-kit would mark the tab (and its input) aria-disabled. While
  // renaming, the drag listeners are simply not attached.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tabId });

  const style: CSSProperties & Record<'--tab-color' | '--group-color', string> = {
    transform: CSS.Translate.toString(transform),
    transition,
    '--tab-color': color ? TAB_COLORS[color] : 'transparent',
    '--group-color': group ? TAB_COLORS[group.color] : 'transparent',
  };

  const activate = () => {
    useWorkspace.getState().activateTab(tabId);
    focusActiveTerminal();
  };
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    useUi.getState().openMenu({ kind: 'tab', tabId, x: event.clientX, y: event.clientY });
  };
  const close = (event: MouseEvent) => {
    event.stopPropagation();
    void requestCloseTabs([tabId]);
  };
  const endRename = (apply?: () => void) => {
    apply?.();
    useUi.getState().stopRename();
    focusActiveTerminal();
  };

  let tooltip = title;
  if (indicator && indicator !== 'activity') tooltip += ` — ${INDICATOR_LABEL[indicator]}${exitCode !== null ? ` (código ${exitCode})` : ''}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...(renaming ? {} : listeners)}
      role="tab"
      aria-selected={active}
      title={tooltip}
      className="tab"
      data-tab-id={tabId}
      data-active={active || undefined}
      data-dragging={isDragging || undefined}
      data-color={color ?? undefined}
      data-group-id={group?.id}
      data-indicator={indicator ?? undefined}
      onClick={activate}
      onDoubleClick={() => useUi.getState().startRenameTab(tabId)}
      onContextMenu={onContextMenu}
      onAuxClick={(event) => event.button === 1 && close(event)}
    >
      {renaming ? (
        <RenameInput
          initial={customTitle ?? title}
          label="Nombre de la tab"
          // Blank goes back to following the process title.
          onCommit={(value) => endRename(() => useWorkspace.getState().renameTab(tabId, value))}
          onCancel={() => endRename()}
        />
      ) : (
        <span className="tab-title">{title}</span>
      )}
      <span className="tab-indicator" aria-label={indicator ? INDICATOR_LABEL[indicator] : undefined} />
      <button
        type="button"
        className="tab-close"
        aria-label="Cerrar tab"
        title="Cerrar tab"
        onClick={close}
        onPointerDown={(event) => event.stopPropagation()}
      >
        ×
      </button>
    </div>
  );
}
