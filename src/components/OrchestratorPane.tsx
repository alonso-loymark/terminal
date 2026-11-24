import { MessagesSquare, RefreshCw, SquarePen, Workflow } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { cancelBusy, detectAgents, draftAgentsMd, ensureProject, newChat, offerClaudeMd, refreshProject, setMainModel, showChatList } from '../lib/orchestratorActions';
import { chatStats } from '../lib/orchestratorChats';
import { formatCost, formatTokens, rankModels } from '../lib/orchestratorModel';
import { paneStyle, sameRect } from '../lib/paneGeometry';
import { shortcutLabel } from '../store/keymap';
import { activeChatOf, selectProject, useOrchestrator, type ProjectState } from '../store/orchestrator';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import type { PaneId, Rect } from '../store/workspaceModel';
import { AiErrorBox } from './AiErrorBox';
import { ModelPicker } from './ModelPicker';
import { OrchestratorComposer } from './OrchestratorComposer';
import { OrchestratorMessage } from './OrchestratorMessage';

function InstructionsBanner({ project }: { project: ProjectState }) {
  const info = project.info;
  const draft = project.draft;
  if (!info) return null;
  const { agents, claude, claudeImportsAgents } = info.instructions;
  if (draft?.status === 'running') {
    return (
      <div className="orch-banner" data-orch="draft">
        <span>
          {draft.purpose === 'update' ? 'Actualizando AGENTS.md (solo lectura)…' : 'Analizando el proyecto para escribir AGENTS.md (solo lectura)…'}{' '}
          {draft.activity.length > 0 && `${draft.activity.length} pasos`}
        </span>
        <button type="button" data-action="orch-cancel-draft" onClick={() => cancelBusy(project.dir)}>
          Cancelar
        </button>
      </div>
    );
  }
  if (draft?.purpose === 'update' && draft.error) {
    return (
      <div className="orch-banner" data-orch="draft-error">
        <AiErrorBox code={draft.error.code} message={draft.error.message} />
      </div>
    );
  }
  if (!agents) {
    return (
      <div className="orch-banner" data-orch="agents-offer">
        <span>
          Este proyecto no tiene <code>AGENTS.md</code> (las instrucciones para cualquier agente). ¿Generar un borrador analizando el proyecto? Te muestro el contenido antes de
          crear nada.
        </span>
        {draft?.error && <AiErrorBox code={draft.error.code} message={draft.error.message} />}
        <button type="button" className="primary" data-action="orch-draft-agents" disabled={project.busy !== null} onClick={() => void draftAgentsMd(project.dir)}>
          Generar AGENTS.md…
        </button>
      </div>
    );
  }
  if (!claudeImportsAgents) {
    return (
      <div className="orch-banner" data-orch="claude-offer">
        <span>
          {claude ? (
            <>
              <code>{claude.path}</code> no importa <code>AGENTS.md</code>: Claude Code no lo va a leer solo.
            </>
          ) : (
            <>
              Falta <code>CLAUDE.md</code>: uno mínimo que importe <code>AGENTS.md</code> para que Claude Code lo lea.
            </>
          )}
        </span>
        <button type="button" data-action="orch-offer-claude" onClick={() => offerClaudeMd(project.dir)}>
          {claude ? 'Agregar la importación…' : 'Crear CLAUDE.md…'}
        </button>
      </div>
    );
  }
  return null;
}

interface Props {
  paneId: PaneId;
  visible: boolean;
  focused: boolean;
  rect: Rect;
}

/** An "Orquestador" tab: the chats of one project folder (the pane's `cwd`), one on screen. */
export const OrchestratorPane = memo(
  function OrchestratorPane({ paneId, visible, focused, rect }: Props) {
    const dir = useWorkspace((s) => s.panes[paneId]?.cwd ?? null);
    const project = useOrchestrator(selectProject(dir));
    const agents = useOrchestrator((s) => s.agents);
    const agentsError = useOrchestrator((s) => s.agentsError);
    const detecting = useOrchestrator((s) => s.detecting);
    const enabled = useSettings((s) => s.settings.orchestrator.enabled);
    const defaultModel = useSettings((s) => s.settings.orchestrator.mainModel);
    const logRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (dir && enabled) void ensureProject(dir);
    }, [dir, enabled]);

    const claude = agents?.find((a) => a.id === 'claude');
    const models = useMemo(() => rankModels(claude?.models ?? []), [claude]);
    const chat = activeChatOf(project);
    const messages = chat?.messages ?? null;
    const busy = project?.busy != null;
    const busyChat = project?.busy?.chatId ?? null;
    // Something else of the project runs (another chat's task, AGENTS.md): this input waits.
    const busyElsewhere = busy && busyChat !== chat?.id ? { chatId: busyChat, title: busyChat ? (project?.chats.find((c) => c.id === busyChat)?.title ?? 'otro chat') : 'AGENTS.md' } : null;
    const totals = useMemo(() => chatStats(messages ?? []), [messages]);
    const base = project?.info?.dir ?? dir ?? '';

    // Follow the conversation while it grows (and start at the end of a chat when it opens).
    useLayoutEffect(() => {
      const log = logRef.current;
      if (log && visible) log.scrollTop = log.scrollHeight;
    }, [messages, visible]);

    useEffect(() => {
      if (visible && selectActivePaneId(useWorkspace.getState()) === paneId) {
        const ui = useUi.getState();
        if (!ui.settings && !ui.palette && !ui.confirm && !ui.menu && !useOrchestrator.getState().dialog) {
          document.querySelector<HTMLTextAreaElement>(`textarea[data-orch-input="${CSS.escape(paneId)}"]`)?.focus();
        }
      }
    }, [visible, paneId, chat?.id]);

    const main = dir ? (project?.prefs.mainModel ?? defaultModel) : defaultModel;
    const projectCost = project?.decisions.reduce((sum, d) => sum + d.costUsd, 0) ?? 0;
    const totalTitle = [
      `Este chat: ${formatCost(totals.costUsd)}, ${formatTokens(totals.tokens)} tokens (planes y tareas, según Claude Code).`,
      ...(project?.decisions.length ? [`Proyecto: ${project.decisions.length} tareas, ${formatCost(projectCost)} (registro de decisiones).`] : []),
    ].join('\n');
    const newKey = shortcutLabel('orchestrator.newChat');

    return (
      <div
        className="terminal-pane orch-pane"
        data-pane-id={paneId}
        data-kind="orchestrator"
        data-focused={focused || undefined}
        hidden={!visible}
        style={paneStyle(rect)}
        onPointerDown={() => {
          if (selectActivePaneId(useWorkspace.getState()) !== paneId) useWorkspace.getState().focusPane(paneId);
        }}
      >
        <header className="orch-header">
          <button type="button" className="orch-icon-button" data-action="orch-show-chats" title="Chats del proyecto" onClick={showChatList}>
            <MessagesSquare aria-hidden="true" />
          </button>
          <div className="orch-title">
            <strong className="orch-chat-title" data-orch="chat-heading" title={chat?.title}>
              {chat?.title ?? 'Orquestador'}
            </strong>
            <span className="orch-muted with-icon" title={project?.info?.dir ?? dir ?? ''}>
              <Workflow aria-hidden="true" />
              {project?.info?.name ?? dir}
            </span>
          </div>
          {totals.costUsd > 0 && (
            <span className="orch-total" data-orch="chat-total" title={totalTitle}>
              {formatCost(totals.costUsd)} · {formatTokens(totals.tokens)} tokens
            </span>
          )}
          <label className="orch-main-model" title="El modelo que arma el plan de cada mensaje">
            <span>Plan</span>
            <ModelPicker models={models} model={main} effort={null} part="main" showEffort={false} onChange={(m) => dir && setMainModel(dir, m)} />
          </label>
          <span className="orch-agent" data-orch="agent-status" title={claude?.path ?? ''}>
            {detecting && !claude ? 'Detectando Claude Code…' : claude ? `${claude.name} ${claude.version?.split(' ')[0] ?? ''}${claude.loggedIn === false ? ' · sin sesión' : ''}` : ''}
          </span>
          <button
            type="button"
            className="orch-icon-button"
            data-action="orch-refresh-agents"
            title="Volver a leer el proyecto y a detectar los agentes y sus modelos"
            onClick={() => {
              void detectAgents(true);
              if (dir) void refreshProject(dir);
            }}
          >
            <RefreshCw aria-hidden="true" />
          </button>
          <button type="button" className="orch-icon-button" data-action="orch-header-new-chat" title={newKey ? `Chat nuevo (${newKey})` : 'Chat nuevo'} disabled={!project?.info} onClick={() => dir && newChat(dir)}>
            <SquarePen aria-hidden="true" />
          </button>
        </header>
        {!enabled && (
          <div className="orch-banner" data-orch="disabled">
            <span>El modo orquestador está desactivado (orchestrator.enabled: false).</span>
            <button type="button" onClick={() => useUi.getState().openSettings('agents')}>
              Configuración
            </button>
          </div>
        )}
        {agentsError && <AiErrorBox code={agentsError.code} message={agentsError.message} />}
        {claude?.error && <AiErrorBox code={claude.error.code} message={claude.error.message} />}
        {project?.loadError && (
          <div className="ai-error" role="alert">
            {project.loadError}
          </div>
        )}
        {project && enabled && <InstructionsBanner project={project} />}
        <div ref={logRef} className="orch-log" data-orch="log" data-chat-id={chat?.id}>
          <div className="orch-thread">
            {messages === null && project?.loaded && <p className="orch-muted">Cargando el chat…</p>}
            {messages?.length === 0 && (
              <div className="orch-empty">
                <p>
                  Escribí qué querés hacer en este proyecto. Por cada mensaje propongo un plan (agente, modelo y esfuerzo) y lo ejecuto con Claude Code cuando lo apruebes.
                </p>
                <p className="orch-muted">
                  <code>@haiku</code>, <code>@sonnet</code> u <code>@opus</code> al principio eligen el modelo. Los trabajadores editan archivos y solo ejecutan los comandos del
                  proyecto ({project?.info?.commands.length ?? 0} detectados); cualquier otra cosa te la pregunto. Cada chat tiene su propio contexto; las decisiones son del
                  proyecto.
                </p>
              </div>
            )}
            {dir && messages?.map((m) => <OrchestratorMessage key={m.id} dir={dir} base={base} message={m} models={models} busy={busy} />)}
          </div>
        </div>
        <OrchestratorComposer
          paneId={paneId}
          dir={dir}
          models={models}
          ready={enabled && !!project?.info && messages !== null}
          busyHere={busyChat !== null && busyChat === chat?.id}
          busyElsewhere={busyElsewhere}
        />
      </div>
    );
  },
  (a, b) => a.paneId === b.paneId && a.visible === b.visible && a.focused === b.focused && sameRect(a.rect, b.rect),
);
