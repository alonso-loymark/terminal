import { useDroppable } from '@dnd-kit/core';
import type { CSSProperties, MouseEvent } from 'react';
import { TAB_COLORS } from '../config/colors';
import { focusActiveTerminal } from '../lib/tabActions';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { tabsInGroup, type GroupId } from '../store/workspaceModel';
import { RenameInput } from './RenameInput';

/** Chrome-style group label: click collapses/expands, dropping a tab on it adds it to the group. */
export function GroupChip({ groupId }: { groupId: GroupId }) {
  const group = useWorkspace((s) => s.groups[groupId]);
  const count = useWorkspace((s) => tabsInGroup(s, groupId).length);
  const renaming = useUi((s) => s.renamingGroupId === groupId);
  const { setNodeRef, isOver } = useDroppable({ id: `group:${groupId}` });
  if (!group) return null;

  const style: CSSProperties & Record<'--group-color', string> = { '--group-color': TAB_COLORS[group.color] };
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    useUi.getState().openMenu({ kind: 'group', groupId, x: event.clientX, y: event.clientY });
  };
  const endRename = (apply?: () => void) => {
    apply?.();
    useUi.getState().stopRename();
    focusActiveTerminal();
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      role="button"
      tabIndex={-1}
      className="group-chip"
      data-group-chip={groupId}
      data-color={group.color}
      data-collapsed={group.collapsed || undefined}
      data-drop-target={isOver || undefined}
      aria-expanded={!group.collapsed}
      title={`${group.name || 'Grupo'} — clic para ${group.collapsed ? 'expandir' : 'colapsar'}`}
      onClick={() => !renaming && useWorkspace.getState().toggleGroupCollapsed(groupId)}
      onContextMenu={onContextMenu}
    >
      {renaming ? (
        <RenameInput
          initial={group.name}
          label="Nombre del grupo"
          onCommit={(value) => endRename(() => useWorkspace.getState().renameGroup(groupId, value))}
          onCancel={() => endRename()}
        />
      ) : (
        <span className="group-name">{group.name}</span>
      )}
      {group.collapsed && <span className="group-count">{count}</span>}
    </div>
  );
}
