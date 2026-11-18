import { useShallow } from 'zustand/react/shallow';
import { TAB_COLORS } from '../config/colors';
import { closeOtherTabs, focusActiveTerminal, groupTab, requestClosePane, requestCloseTabs } from '../lib/tabActions';
import { useSystem } from '../store/system';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { parentSplit, tabOfPane, tabsInGroup, type GroupId, type PaneId, type TabId } from '../store/workspaceModel';
import { ColorSwatches, Menu, MenuItem, MenuLabel, MenuSeparator } from './Menu';

const closeMenu = () => useUi.getState().closeMenu();
const dismiss = () => {
  closeMenu();
  focusActiveTerminal();
};
/** Closes the menu, then runs the action. */
const run = (action: () => void) => () => {
  closeMenu();
  action();
};

/** The open context menu (tab, group or pane), if any. */
export function ContextMenus() {
  const menu = useUi((s) => s.menu);
  if (!menu) return null;
  if (menu.kind === 'tab') return <TabMenu tabId={menu.tabId} x={menu.x} y={menu.y} />;
  if (menu.kind === 'group') return <GroupMenu groupId={menu.groupId} x={menu.x} y={menu.y} />;
  if (menu.kind === 'shells') return <ShellMenu x={menu.x} y={menu.y} />;
  return <PaneMenu paneId={menu.paneId} x={menu.x} y={menu.y} />;
}

/** "▾" next to "+": a new tab with any of the available shells, in the active pane's folder. */
function ShellMenu({ x, y }: { x: number; y: number }) {
  const shells = useSystem((s) => s.shells);
  return (
    <Menu x={x} y={y} label="Nueva tab con" onClose={dismiss}>
      <MenuLabel>Nueva tab con</MenuLabel>
      {shells.map((shell) => (
        <MenuItem
          key={shell.kind}
          action="new-tab-shell"
          data-shell={shell.kind}
          onSelect={run(() => {
            useWorkspace.getState().newTab({ shell: shell.kind });
            focusActiveTerminal();
          })}
        >
          {shell.name}
        </MenuItem>
      ))}
    </Menu>
  );
}

/** Shift+right click on a terminal, or Shift+F10 / the menu key. */
function PaneMenu({ paneId, x, y }: { paneId: PaneId; x: number; y: number }) {
  const tab = useWorkspace((s) => {
    const tabId = tabOfPane(s, paneId);
    return tabId ? s.tabs[tabId] : undefined;
  });
  if (!tab) return null;
  const ws = useWorkspace.getState();
  const split = parentSplit(tab.layout, paneId);
  const zoomed = tab.zoomedPaneId === paneId;
  const act = (action: () => void) =>
    run(() => {
      action();
      focusActiveTerminal();
    });

  return (
    <Menu x={x} y={y} label="Acciones del panel" onClose={dismiss}>
      <MenuItem action="split-right" shortcut="Alt+Shift+D" onSelect={act(() => ws.splitPane('horizontal', paneId))}>
        Dividir a la derecha
      </MenuItem>
      <MenuItem action="split-down" shortcut="Alt+Shift+-" onSelect={act(() => ws.splitPane('vertical', paneId))}>
        Dividir hacia abajo
      </MenuItem>
      <MenuItem
        action="zoom"
        shortcut="Ctrl+Shift+Z"
        disabled={tab.layout.type === 'pane'}
        onSelect={act(() => {
          ws.focusPane(paneId);
          ws.toggleZoom();
        })}
      >
        {zoomed ? 'Restaurar paneles' : 'Maximizar panel'}
      </MenuItem>
      <MenuItem action="equalize" disabled={!split} onSelect={act(() => split && ws.equalizeSplit(split.id))}>
        Igualar tamaños
      </MenuItem>
      <MenuSeparator />
      <MenuItem action="close-pane" shortcut="Ctrl+Shift+W" onSelect={run(() => void requestClosePane(paneId))}>
        Cerrar panel
      </MenuItem>
    </Menu>
  );
}

function TabMenu({ tabId, x, y }: { tabId: TabId; x: number; y: number }) {
  const tab = useWorkspace((s) => s.tabs[tabId]);
  const groups = useWorkspace(useShallow((s) => Object.values(s.groups)));
  const tabCount = useWorkspace((s) => s.tabOrder.length);
  if (!tab) return null;
  const ws = useWorkspace.getState();
  const otherGroups = groups.filter((g) => g.id !== tab.groupId);

  return (
    <Menu x={x} y={y} label="Acciones de la tab" onClose={dismiss}>
      <MenuItem action="rename" shortcut="F2" onSelect={run(() => useUi.getState().startRenameTab(tabId))}>
        Renombrar
      </MenuItem>
      <MenuLabel>Color</MenuLabel>
      <ColorSwatches
        value={tab.color}
        allowNone
        onPick={(color) => {
          ws.setTabColor(tabId, color);
          dismiss();
        }}
      />
      <MenuItem action="duplicate" onSelect={run(() => {
          ws.duplicateTab(tabId);
          focusActiveTerminal();
        })}>
        Duplicar
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Mover a grupo</MenuLabel>
      <MenuItem action="new-group" shortcut="Ctrl+Shift+G" onSelect={run(() => groupTab(tabId))}>
        Nuevo grupo
      </MenuItem>
      {otherGroups.map((group) => (
        <MenuItem
          key={group.id}
          action="move-to-group"
          data-group-id={group.id}
          onSelect={run(() => {
            ws.moveTabToGroup(tabId, group.id);
            focusActiveTerminal();
          })}
        >
          <span className="menu-dot" style={{ background: TAB_COLORS[group.color] }} />
          {group.name || 'Grupo sin nombre'}
        </MenuItem>
      ))}
      {tab.groupId && (
        <MenuItem action="remove-from-group" onSelect={run(() => {
            ws.removeFromGroup(tabId);
            focusActiveTerminal();
          })}>
          Quitar del grupo
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem action="close" onSelect={run(() => void requestCloseTabs([tabId]))}>
        Cerrar
      </MenuItem>
      <MenuItem action="close-others" disabled={tabCount < 2} onSelect={run(() => void closeOtherTabs(tabId))}>
        Cerrar las demás
      </MenuItem>
    </Menu>
  );
}

function GroupMenu({ groupId, x, y }: { groupId: GroupId; x: number; y: number }) {
  const group = useWorkspace((s) => s.groups[groupId]);
  if (!group) return null;
  const ws = useWorkspace.getState();

  return (
    <Menu x={x} y={y} label="Acciones del grupo" onClose={dismiss}>
      <MenuItem action="rename-group" onSelect={run(() => useUi.getState().startRenameGroup(groupId))}>
        Renombrar grupo
      </MenuItem>
      <MenuLabel>Color</MenuLabel>
      <ColorSwatches
        value={group.color}
        onPick={(color) => {
          if (color) ws.setGroupColor(groupId, color);
          dismiss();
        }}
      />
      <MenuItem action="toggle-group" onSelect={run(() => {
          ws.toggleGroupCollapsed(groupId);
          focusActiveTerminal();
        })}>
        {group.collapsed ? 'Expandir' : 'Colapsar'}
      </MenuItem>
      <MenuItem action="ungroup" onSelect={run(() => {
          ws.ungroup(groupId);
          focusActiveTerminal();
        })}>
        Desagrupar
      </MenuItem>
      <MenuSeparator />
      <MenuItem action="close-group" onSelect={run(() => void requestCloseTabs(tabsInGroup(ws, groupId)))}>
        Cerrar grupo
      </MenuItem>
    </Menu>
  );
}
