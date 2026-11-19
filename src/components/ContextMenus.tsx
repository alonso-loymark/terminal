import { useShallow } from 'zustand/react/shallow';
import { TAB_COLORS } from '../config/colors';
import {
  copyPath,
  openInEditor,
  openInWindowsExplorer,
  openTabAt,
  requestTrash,
  splitAt,
  startCreate,
} from '../lib/explorerActions';
import { readText } from '../lib/clipboard';
import { parentDir } from '../lib/explorerModel';
import { copySelection } from '../lib/keybindings';
import { closeOtherTabs, focusActiveTerminal, groupTab, requestClosePane, requestCloseTabs } from '../lib/tabActions';
import { getPane } from '../lib/terminalRegistry';
import { useExplorer } from '../store/explorer';
import { useProfiles } from '../store/profiles';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { parentSplit, tabOfPane, tabsInGroup, type GroupId, type PaneId, type TabId } from '../store/workspaceModel';
import { ColorSwatches, Menu, MenuItem, MenuLabel, MenuSeparator } from './Menu';
import { ProfileIcon } from './ProfileIcon';

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
  if (menu.kind === 'explorer') return <ExplorerMenu path={menu.path} isDir={menu.isDir} isRoot={menu.isRoot} x={menu.x} y={menu.y} />;
  return <PaneMenu paneId={menu.paneId} x={menu.x} y={menu.y} clipboard={menu.clipboard} />;
}

/** Right click in the file explorer (an entry, or the empty area for the root folder). */
function ExplorerMenu({ path, isDir, isRoot, x, y }: { path: string; isDir: boolean; isRoot: boolean; x: number; y: number }) {
  // New files and folders go inside a folder, or next to a file.
  const folder = isDir ? path : (parentDir(path) ?? path);
  return (
    <Menu x={x} y={y} label={isDir ? 'Acciones de la carpeta' : 'Acciones del archivo'} onClose={dismiss}>
      <MenuItem action="open-vscode" onSelect={run(() => openInEditor(path))}>
        Abrir en VS Code
      </MenuItem>
      <MenuItem action="open-file-manager" onSelect={run(() => openInWindowsExplorer(path))}>
        Abrir en el Explorador de Windows
      </MenuItem>
      <MenuSeparator />
      <MenuItem action="tab-here" onSelect={run(() => openTabAt(path, isDir))}>
        Abrir una tab nueva aquí
      </MenuItem>
      <MenuItem action="split-here" onSelect={run(() => splitAt(path, isDir))}>
        Dividir panel aquí
      </MenuItem>
      <MenuSeparator />
      <MenuItem action="copy-path" onSelect={run(() => void copyPath(path))}>
        Copiar ruta
      </MenuItem>
      <MenuItem action="copy-relative-path" onSelect={run(() => void copyPath(path, true))}>
        Copiar ruta relativa
      </MenuItem>
      <MenuSeparator />
      <MenuItem action="new-file" onSelect={run(() => startCreate(folder, 'file'))}>
        Nuevo archivo
      </MenuItem>
      <MenuItem action="new-folder" onSelect={run(() => startCreate(folder, 'dir'))}>
        Nueva carpeta
      </MenuItem>
      {!isRoot && (
        <>
          <MenuItem action="rename-entry" onSelect={run(() => useExplorer.getState().setEditing({ kind: 'rename', path }))}>
            Renombrar
          </MenuItem>
          <MenuItem action="trash" onSelect={run(() => requestTrash(path))}>
            Eliminar
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

/** "▾" next to "+": a new tab with any profile (hidden ones aside), and the settings. */
function ShellMenu({ x, y }: { x: number; y: number }) {
  const { profiles, defaultId } = useProfiles();
  return (
    <Menu x={x} y={y} label="Nueva tab con" onClose={dismiss}>
      <MenuLabel>Nueva tab con</MenuLabel>
      {profiles
        .filter((profile) => !profile.hidden)
        .map((profile) => (
          <MenuItem
            key={profile.id}
            action="new-tab-profile"
            data-profile={profile.id}
            shortcut={profile.id === defaultId ? 'Ctrl+Shift+T' : undefined}
            onSelect={run(() => {
              useWorkspace.getState().newTab({ profile: profile.id });
              focusActiveTerminal();
            })}
          >
            <ProfileIcon profile={profile} />
            {profile.name}
          </MenuItem>
        ))}
      <MenuSeparator />
      <MenuItem action="open-settings" shortcut="Ctrl+," onSelect={run(() => useUi.getState().openSettings('profiles'))}>
        Configuración
      </MenuItem>
    </Menu>
  );
}

/**
 * Shift+right click on a terminal, or Shift+F10 / the menu key; also a plain right click when
 * the settings ask for a context menu (then with copy and paste on top).
 */
function PaneMenu({ paneId, x, y, clipboard = false }: { paneId: PaneId; x: number; y: number; clipboard?: boolean }) {
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

  const term = getPane(paneId)?.term;
  const hasSelection = term?.hasSelection() ?? false;

  return (
    <Menu x={x} y={y} label="Acciones del panel" onClose={dismiss}>
      {clipboard && term && (
        <>
          <MenuItem action="copy" shortcut="Ctrl+C" disabled={!hasSelection} onSelect={act(() => copySelection(term))}>
            Copiar
          </MenuItem>
          <MenuItem
            action="paste"
            shortcut="Ctrl+V"
            onSelect={act(() => {
              void readText().then((text) => {
                if (text) term.paste(text);
              });
            })}
          >
            Pegar
          </MenuItem>
          <MenuItem action="select-all" onSelect={act(() => term.selectAll())}>
            Seleccionar todo
          </MenuItem>
          <MenuItem action="find" shortcut="Ctrl+Shift+F" onSelect={run(() => useUi.getState().openSearch())}>
            Buscar
          </MenuItem>
          <MenuItem action="clear" onSelect={act(() => term.clear())}>
            Limpiar
          </MenuItem>
          <MenuSeparator />
        </>
      )}
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
