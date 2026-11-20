import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AiErrorCode } from '../lib/aiApi';
import type { FileDiff, ToolAction } from '../lib/agentsApi';
import {
  allowDenials,
  approvePlan,
  cancelBusy,
  cancelPlan,
  changePlanModel,
  detectAgents,
  draftAgentsMd,
  ensureProject,
  ignoreDenials,
  offerClaudeMd,
  refreshProject,
  retryPlan,
  sendMessage,
  setMainModel,
  showSent,
} from '../lib/orchestratorActions';
import { formatCost, rankModels, usageLine, type OrchMessage, type RankedModel } from '../lib/orchestratorModel';
import { inlineParts } from '../lib/aiPrompts';
import { paneStyle, sameRect } from '../lib/paneGeometry';
import { selectProject, useOrchestrator, type ProjectState } from '../store/orchestrator';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import type { PaneId, Rect } from '../store/workspaceModel';
import { AiErrorBox } from './AiErrorBox';

const ACTION_ICON: Record<ToolAction, string> = { read: '📖', edit: '✏️', write: '🆕', command: '▶', search: '🔎', other: '•' };
const ACTION_LABEL: Record<ToolAction, string> = { read: 'Leyó', edit: 'Editó', write: 'Creó', command: 'Ejecutó', search: 'Buscó', other: 'Usó' };

/** Text with `code` and **bold**, one paragraph per blank line. */
function RichText({ text, className = 'orch-text' }: { text: string; className?: string }) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  return (
    <div className={className}>
      {paragraphs.map((p, i) => (
        <p key={i}>
          {inlineParts(p).map((part, j) =>
            part.type === 'code' ? <code key={j}>{part.text}</code> : part.type === 'bold' ? <strong key={j}>{part.text}</strong> : <span key={j}>{part.text}</span>,
          )}
        </p>
      ))}
    </div>
  );
}

function ModelPicker({
  models,
  model,
  effort,
  onChange,
  part,
  showEffort = true,
}: {
  models: RankedModel[];
  model: string;
  effort: string | null;
  onChange: (model: string, effort: string | null) => void;
  part: string;
  showEffort?: boolean;
}) {
  const current = models.find((m) => m.value === model);
  return (
    <span className="orch-picker">
      <select data-orch={`${part}-model`} value={model} onChange={(e) => onChange(e.target.value, effort)} aria-label="Modelo">
        {!current && <option value={model}>{model}</option>}
        {models.map((m) => (
          <option key={m.value} value={m.value} title={m.description}>
            {m.displayName} ({m.tier})
          </option>
        ))}
      </select>
      {showEffort && current && current.efforts.length > 0 && (
        <select data-orch={`${part}-effort`} value={effort ?? ''} onChange={(e) => onChange(model, e.target.value || null)} aria-label="Esfuerzo">
          {current.efforts.map((e) => (
            <option key={e} value={e}>
              esfuerzo {e}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

function PlanCard({ dir, message, models, busy }: { dir: string; message: Extract<OrchMessage, { kind: 'plan' }>; models: RankedModel[]; busy: boolean }) {
  const [changing, setChanging] = useState(false);
  const plan = message.plan;
  const model = plan ? models.find((m) => m.value === plan.model) : undefined;
  return (
    <div className="orch-card orch-plan" data-orch="plan" data-status={message.status} data-id={message.id}>
      <div className="orch-card-head">
        <strong>Plan</strong>
        {message.status === 'thinking' && <span className="orch-muted">Pensando el plan…</span>}
        {message.status === 'approved' && <span className="orch-badge" data-tone="ok">aprobado</span>}
        {message.status === 'cancelled' && <span className="orch-badge">cancelado</span>}
        {message.sent && (
          <button type="button" className="ai-link" data-action="orch-sent" onClick={() => showSent(message.sent)}>
            Ver qué se envió
          </button>
        )}
      </div>
      {plan && (
        <>
          <RichText text={plan.task} />
          <div className="orch-plan-meta">
            <span className="orch-chip" data-orch="plan-agent">
              Claude Code
            </span>
            <span className="orch-chip" data-orch="plan-model" title={model?.description}>
              {model?.displayName ?? plan.model}
              {model ? ` · ${model.tier}` : ''}
            </span>
            {plan.effort && (
              <span className="orch-chip" data-orch="plan-effort">
                esfuerzo {plan.effort}
              </span>
            )}
            {message.chosen && <span className="orch-chip" data-tone="accent">elegido por vos</span>}
          </div>
          <p className="orch-why" data-orch="plan-why">
            {plan.why}
          </p>
          {plan.files.length > 0 && <p className="orch-muted orch-files">Archivos: {plan.files.join(', ')}</p>}
        </>
      )}
      {message.error && <AiErrorBox code={message.error.code as AiErrorCode} message={message.error.message} />}
      {message.usage && <p className="orch-usage">Plan: {usageLine(message.usage)}</p>}
      {message.status === 'proposed' && plan && (
        <div className="orch-actions">
          {changing && (
            <ModelPicker models={models} model={plan.model} effort={plan.effort} part="change" onChange={(m, e) => changePlanModel(dir, message.id, m, e)} />
          )}
          <button type="button" className="primary" data-action="orch-approve" disabled={busy} onClick={() => void approvePlan(dir, message.id)}>
            Aprobar
          </button>
          <button type="button" data-action="orch-change-model" aria-pressed={changing} onClick={() => setChanging((c) => !c)}>
            Cambiar modelo
          </button>
          <button type="button" data-action="orch-cancel-plan" onClick={() => cancelPlan(dir, message.id)}>
            Cancelar
          </button>
        </div>
      )}
      {message.status === 'thinking' && (
        <div className="orch-actions">
          <button type="button" data-action="orch-cancel-plan" onClick={() => cancelPlan(dir, message.id)}>
            Cancelar
          </button>
        </div>
      )}
      {(message.status === 'error' || message.status === 'cancelled') && !busy && (
        <div className="orch-actions">
          <button type="button" data-action="orch-retry" onClick={() => void retryPlan(dir, message.id)}>
            Reintentar
          </button>
        </div>
      )}
    </div>
  );
}

function DiffView({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="orch-diff-file" data-path={file.path} data-status={file.status}>
      <button type="button" className="orch-diff-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="orch-diff-status" data-status={file.status}>
          {file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}
        </span>
        <span className="orch-diff-path">{file.path}</span>
        {file.binary ? <span className="orch-muted">binario</span> : <span className="orch-diff-counts"><span data-tone="add">+{file.additions}</span> <span data-tone="del">−{file.deletions}</span></span>}
      </button>
      {open && !file.binary && (
        <pre className="orch-diff-text">
          {file.diff.split('\n').map((line, i) => (
            <span key={i} data-line={line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : undefined}>
              {line}
              {'\n'}
            </span>
          ))}
          {file.truncated && <span className="orch-muted">(recortado)</span>}
        </pre>
      )}
    </div>
  );
}

function RunCard({ dir, message, busy }: { dir: string; message: Extract<OrchMessage, { kind: 'run' }>; busy: boolean }) {
  const running = message.status === 'running';
  const allowable = message.denials.some((d) => d.allow.length > 0);
  return (
    <div className="orch-card orch-run" data-orch="run" data-status={message.status} data-id={message.id}>
      <div className="orch-card-head">
        <strong>{message.resumed ? 'Continuación' : 'Tarea'}</strong>
        <span className="orch-muted">
          Claude Code · {message.model}
          {message.effort ? ` · esfuerzo ${message.effort}` : ''}
        </span>
        {running && <span className="orch-badge" data-tone="working">trabajando</span>}
        {message.status === 'done' && <span className="orch-badge" data-tone="ok">terminada</span>}
        {message.status === 'error' && <span className="orch-badge" data-tone="error">falló</span>}
        {message.status === 'cancelled' && <span className="orch-badge">cancelada</span>}
        {message.sent && (
          <button type="button" className="ai-link" data-action="orch-sent" onClick={() => showSent(message.sent)}>
            Ver qué se envió
          </button>
        )}
      </div>
      {message.activity.length > 0 && (
        <ul className="orch-activity" data-orch="activity">
          {message.activity.map((a) => (
            <li key={a.id} data-action={a.action} data-ok={a.ok === null ? 'running' : String(a.ok)} title={a.tool}>
              <span className="orch-activity-icon" aria-hidden="true">
                {ACTION_ICON[a.action]}
              </span>
              <span className="orch-activity-verb">{ACTION_LABEL[a.action]}</span>
              <code className="orch-activity-target">{a.target || a.tool}</code>
              {a.ok === false && <span className="orch-activity-fail">✗</span>}
            </li>
          ))}
        </ul>
      )}
      {running && message.text && <RichText text={message.text} className="orch-text orch-live" />}
      {message.result && (
        <div data-orch="result">
          <RichText text={message.result} />
        </div>
      )}
      {message.error && <AiErrorBox code={message.error.code as AiErrorCode} message={message.error.message} />}
      {message.denials.length > 0 && (
        <div className="orch-question" role="group" data-orch="denials">
          <strong>El agente pidió algo que no está permitido (no se ejecutó):</strong>
          <ul>
            {message.denials.map((d, i) => (
              <li key={i}>
                {ACTION_LABEL[d.action]} <code>{d.target || d.tool}</code>
                {d.allow.length === 0 && <span className="orch-muted"> (no se puede permitir desde Brisa)</span>}
              </li>
            ))}
          </ul>
          <div className="orch-actions">
            {allowable && message.sessionId && (
              <>
                <button type="button" className="primary" data-action="orch-allow" disabled={busy} onClick={() => void allowDenials(dir, message.id, false)}>
                  Permitir y continuar
                </button>
                <button type="button" data-action="orch-allow-always" disabled={busy} onClick={() => void allowDenials(dir, message.id, true)}>
                  Permitir siempre en este proyecto
                </button>
              </>
            )}
            <button type="button" data-action="orch-ignore" onClick={() => ignoreDenials(dir, message.id)}>
              No permitir
            </button>
          </div>
        </div>
      )}
      {message.diff && (message.diff.files.length > 0 || message.diff.touched.length > 0) && (
        <div className="orch-diff" data-orch="diff">
          <strong>Cambios</strong>
          {message.diff.files.map((f) => (
            <DiffView key={f.path} file={f} />
          ))}
          {!message.diff.git && (
            <p className="orch-muted">
              Sin git no hay diff. Archivos editados: {message.diff.touched.join(', ')}
            </p>
          )}
        </div>
      )}
      {message.diff && message.status === 'done' && message.diff.git && message.diff.files.length === 0 && <p className="orch-muted">Sin cambios en los archivos.</p>}
      {message.usage && (
        <p className="orch-usage" data-orch="usage">
          {usageLine(message.usage)}
          {message.usage.turns ? ` · ${message.usage.turns} turnos` : ''}
        </p>
      )}
      {running && (
        <div className="orch-actions">
          <button type="button" data-action="orch-cancel-run" onClick={() => cancelBusy(dir)}>
            Cancelar
          </button>
        </div>
      )}
    </div>
  );
}

function Message({ dir, message, models, busy }: { dir: string; message: OrchMessage; models: RankedModel[]; busy: boolean }) {
  switch (message.kind) {
    case 'user':
      return (
        <div className="orch-user" data-orch="user">
          {message.forced && <span className="orch-chip" data-tone="accent">@{message.forced}</span>}
          <span>{message.text}</span>
        </div>
      );
    case 'plan':
      return <PlanCard dir={dir} message={message} models={models} busy={busy} />;
    case 'run':
      return <RunCard dir={dir} message={message} busy={busy} />;
    case 'note':
      return (
        <div className="orch-note" data-orch="note">
          <RichText text={message.text} className="orch-note-text" />
        </div>
      );
  }
}

function InstructionsBanner({ project }: { project: ProjectState }) {
  const info = project.info;
  const draft = project.draft;
  if (!info) return null;
  const { agents, claude, claudeImportsAgents } = info.instructions;
  if (draft?.status === 'running') {
    return (
      <div className="orch-banner" data-orch="draft">
        <span>Analizando el proyecto para escribir AGENTS.md (solo lectura)… {draft.activity.length > 0 && `${draft.activity.length} pasos`}</span>
        <button type="button" data-action="orch-cancel-draft" onClick={() => cancelBusy(project.dir)}>
          Cancelar
        </button>
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

/** An "Orquestador" tab: the chat of one project folder (the pane's `cwd`). */
export const OrchestratorPane = memo(
  function OrchestratorPane({ paneId, visible, focused, rect }: Props) {
    const dir = useWorkspace((s) => s.panes[paneId]?.cwd ?? null);
    const project = useOrchestrator(selectProject(dir));
    const agents = useOrchestrator((s) => s.agents);
    const agentsError = useOrchestrator((s) => s.agentsError);
    const detecting = useOrchestrator((s) => s.detecting);
    const enabled = useSettings((s) => s.settings.orchestrator.enabled);
    const defaultModel = useSettings((s) => s.settings.orchestrator.mainModel);
    const [input, setInput] = useState('');
    const logRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
      if (dir && enabled) void ensureProject(dir);
    }, [dir, enabled]);

    const claude = agents?.find((a) => a.id === 'claude');
    const models = useMemo(() => rankModels(claude?.models ?? []), [claude]);
    const messages = project?.messages;
    const busy = project?.busy !== null && project?.busy !== undefined;

    // Follow the conversation while it grows.
    useLayoutEffect(() => {
      const log = logRef.current;
      if (log && visible) log.scrollTop = log.scrollHeight;
    }, [messages, visible]);

    useEffect(() => {
      if (visible && selectActivePaneId(useWorkspace.getState()) === paneId) {
        const ui = useUi.getState();
        if (!ui.settings && !ui.palette && !ui.confirm && !ui.menu && !useOrchestrator.getState().dialog) inputRef.current?.focus();
      }
    }, [visible, paneId]);

    const send = () => {
      if (!dir || !input.trim() || busy) return;
      const text = input;
      setInput('');
      void sendMessage(dir, text);
    };
    const main = dir ? (project?.prefs.mainModel ?? defaultModel) : defaultModel;

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
          <div className="orch-title">
            <strong>Orquestador</strong>
            <span className="orch-muted" title={project?.info?.dir ?? dir ?? ''}>
              {project?.info?.name ?? dir}
            </span>
          </div>
          <label className="orch-main-model">
            <span>Modelo principal</span>
            <ModelPicker
              models={models}
              model={main}
              effort={null}
              part="main"
              showEffort={false}
              onChange={(m) => dir && setMainModel(dir, m)}
            />
          </label>
          <span className="orch-agent" data-orch="agent-status" title={claude?.path ?? ''}>
            {detecting && !claude ? 'Detectando Claude Code…' : claude ? `${claude.name} ${claude.version?.split(' ')[0] ?? ''}${claude.loggedIn === false ? ' · sin sesión' : ''}` : ''}
          </span>
          <button type="button" className="ai-link" data-action="orch-refresh-agents" title="Volver a leer el proyecto y a detectar los agentes y sus modelos" onClick={() => {
              void detectAgents(true);
              if (dir) void refreshProject(dir);
            }}>
            Actualizar
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
        {project?.loadError && <div className="ai-error" role="alert">{project.loadError}</div>}
        {project && enabled && <InstructionsBanner project={project} />}
        <div ref={logRef} className="orch-log" data-orch="log">
          {messages?.length === 0 && (
            <div className="orch-empty">
              <p>
                Escribí qué querés hacer en este proyecto. Por cada mensaje propongo un plan (tarea, agente, modelo y esfuerzo) y lo ejecuto con Claude Code cuando lo apruebes.
              </p>
              <p className="orch-muted">
                <code>@haiku</code>, <code>@sonnet</code> u <code>@opus</code> al principio fuerza el modelo. Los trabajadores editan archivos y solo ejecutan los comandos del
                proyecto ({project?.info?.commands.length ?? 0} detectados); cualquier otra cosa te la pregunto.
              </p>
            </div>
          )}
          {messages?.map((m) => dir && <Message key={m.id} dir={dir} message={m} models={models} busy={busy} />)}
        </div>
        <footer className="orch-input">
          <textarea
            ref={inputRef}
            data-orch-input={paneId}
            rows={2}
            value={input}
            disabled={!enabled || !project?.info}
            placeholder={busy ? 'Trabajando… (Esc cancela)' : 'Qué hay que hacer (Enter envía, Shift+Enter nueva línea)'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              } else if (e.key === 'Escape' && busy && dir) {
                e.preventDefault();
                cancelBusy(dir);
              }
            }}
          />
          <div className="orch-input-side">
            {busy ? (
              <button type="button" data-action="orch-cancel" onClick={() => dir && cancelBusy(dir)}>
                Cancelar
              </button>
            ) : (
              <button type="button" className="primary" data-action="orch-send" disabled={!input.trim() || !enabled || !project?.info} onClick={send}>
                Enviar
              </button>
            )}
            {project && project.decisions.length > 0 && (
              <span className="orch-muted" title="Costo de las tareas de este proyecto (según Claude Code)">
                {project.decisions.length} tareas · {formatCost(project.decisions.reduce((sum, d) => sum + d.costUsd, 0))}
              </span>
            )}
          </div>
        </footer>
      </div>
    );
  },
  (a, b) => a.paneId === b.paneId && a.visible === b.visible && a.focused === b.focused && sameRect(a.rect, b.rect),
);
