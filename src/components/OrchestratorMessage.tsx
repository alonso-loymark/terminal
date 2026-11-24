import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Eye,
  FilePlus,
  FileText,
  ImageIcon,
  LoaderCircle,
  Pencil,
  Search,
  SquareTerminal,
  TriangleAlert,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { lazy, memo, Suspense, useState } from 'react';
import type { AiErrorCode } from '../lib/aiApi';
import type { FileDiff, TaskDiff, ToolAction } from '../lib/agentsApi';
import { revealInExplorer } from '../lib/explorerActions';
import { imagePreview } from '../lib/imagePaste';
import { resolvePath } from '../lib/markdownModel';
import {
  allowDenials,
  approvePlan,
  cancelBusy,
  cancelPlan,
  changePlanModel,
  dismissAgentsStale,
  ignoreDenials,
  retryPlan,
  showSent,
  updateAgentsMd,
} from '../lib/orchestratorActions';
import { activityNow, activitySummary, formatCost, usageDetail, usageShort, type OrchMessage, type RankedModel } from '../lib/orchestratorModel';
import { AiErrorBox } from './AiErrorBox';
import { ModelPicker } from './ModelPicker';

// marked + Prism load the first time an answer is shown (a separate chunk).
const Markdown = lazy(() => import('./Markdown'));

/** A model's markdown (answers, notes, the plan's task): file paths open in the explorer. */
export function Answer({ text, dir, className = 'md' }: { text: string; dir: string | null; className?: string }) {
  const onPath = dir ? (path: string) => void revealInExplorer(resolvePath(dir, path)) : undefined;
  return (
    <Suspense fallback={<div className={`${className} md-plain`}>{text}</div>}>
      <Markdown text={text} onPath={onPath} className={className} />
    </Suspense>
  );
}

const ACTION_ICON: Record<ToolAction, LucideIcon> = { read: FileText, edit: Pencil, write: FilePlus, command: SquareTerminal, search: Search, other: Wrench };
const ACTION_LABEL: Record<ToolAction, string> = { read: 'Leyó', edit: 'Editó', write: 'Creó', command: 'Ejecutó', search: 'Buscó', other: 'Usó' };
const FILE_ACTIONS: ToolAction[] = ['read', 'edit', 'write'];

interface MessageProps {
  /** The project folder (as the backend normalized it). */
  dir: string;
  /** The folder files are relative to. */
  base: string;
  message: OrchMessage;
  models: RankedModel[];
  /** Something runs in the project (one thing at a time). */
  busy: boolean;
}

export const OrchestratorMessage = memo(function OrchestratorMessage({ dir, base, message, models, busy }: MessageProps) {
  switch (message.kind) {
    case 'user':
      return (
        <div className="orch-user" data-orch="user">
          {message.images && message.images.length > 0 && (
            <div className="orch-user-images">
              {message.images.map((path) => {
                const src = imagePreview(path);
                return src ? (
                  <img key={path} src={src} alt="Imagen adjunta" title={path} data-orch="user-image" />
                ) : (
                  <span key={path} className="orch-image-chip" title={path} data-orch="user-image">
                    <ImageIcon aria-hidden="true" />
                    imagen
                  </span>
                );
              })}
            </div>
          )}
          <div className="orch-user-text">
            {message.forced && (
              <span className="orch-chip" data-tone="accent">
                @{message.forced}
              </span>
            )}
            {message.forced ? message.text.replace(/^\s*@\S+\s*/, '') : message.text}
          </div>
        </div>
      );
    case 'plan':
      return <PlanLine dir={dir} message={message} models={models} busy={busy} />;
    case 'run':
      return <RunResponse dir={dir} base={base} message={message} busy={busy} />;
    case 'note':
      return (
        <div className="orch-note" data-orch="note">
          <Answer text={message.text} dir={base} className="md orch-note-text" />
        </div>
      );
  }
});

/** The plan in one line: agent, model, effort and why; the task and files on demand. */
function PlanLine({ dir, message, models, busy }: { dir: string; message: Extract<OrchMessage, { kind: 'plan' }>; models: RankedModel[]; busy: boolean }) {
  const [changing, setChanging] = useState(false);
  const [open, setOpen] = useState(false);
  const plan = message.plan;
  const model = plan ? models.find((m) => m.value === plan.model) : undefined;
  const settled = message.status === 'approved' || message.status === 'cancelled';
  return (
    <div className="orch-plan" data-orch="plan" data-status={message.status} data-id={message.id}>
      <div className="orch-plan-line">
        {message.status === 'thinking' ? (
          <LoaderCircle className="orch-plan-icon spin" aria-hidden="true" />
        ) : message.status === 'approved' ? (
          <Check className="orch-plan-icon" data-tone="ok" aria-hidden="true" />
        ) : message.status === 'cancelled' ? (
          <CircleSlash className="orch-plan-icon" aria-hidden="true" />
        ) : (
          <Workflow className="orch-plan-icon" aria-hidden="true" />
        )}
        {message.status === 'thinking' && <span className="orch-muted">Pensando el plan…</span>}
        {plan && (
          <button type="button" className="orch-plan-summary" aria-expanded={open} title={open ? 'Ocultar la tarea' : 'Ver la tarea que recibe el agente'} onClick={() => setOpen((o) => !o)}>
            <span className="orch-plan-meta">
              <span data-orch="plan-agent">Claude Code</span>
              <span className="orch-sep">·</span>
              <span data-orch="plan-model" title={model?.description}>
                {model?.displayName ?? plan.model}
              </span>
              {plan.effort && (
                <>
                  <span className="orch-sep">·</span>
                  <span data-orch="plan-effort">esfuerzo {plan.effort}</span>
                </>
              )}
              {message.chosen && (
                <span className="orch-chip" data-tone="accent">
                  elegido por vos
                </span>
              )}
            </span>
            <span className="orch-plan-why" data-orch="plan-why" title={plan.why}>
              {plan.why}
            </span>
            {open ? <ChevronDown className="orch-chevron" aria-hidden="true" /> : <ChevronRight className="orch-chevron" aria-hidden="true" />}
          </button>
        )}
        {message.status === 'cancelled' && <span className="orch-muted orch-plan-state">cancelado</span>}
        {message.usage && (
          <span className="orch-cost" title={usageDetail(message.usage, 'Plan (modelo principal)')}>
            {formatCost(message.usage.costUsd)}
          </span>
        )}
        <span className="orch-plan-actions">
          {message.sent && (
            <button type="button" className="orch-icon-button" data-action="orch-sent" title="Ver qué se envió para el plan" onClick={() => showSent(message.sent)}>
              <Eye aria-hidden="true" />
            </button>
          )}
          {message.status === 'proposed' && plan && (
            <>
              <button type="button" className="primary" data-action="orch-approve" disabled={busy} onClick={() => void approvePlan(dir, message.id)}>
                Aprobar
              </button>
              <button type="button" data-action="orch-change-model" aria-pressed={changing} onClick={() => setChanging((c) => !c)}>
                Cambiar modelo
              </button>
              <button type="button" data-action="orch-cancel-plan" onClick={() => cancelPlan(dir, message.id)}>
                Cancelar
              </button>
            </>
          )}
          {message.status === 'thinking' && (
            <button type="button" data-action="orch-cancel-plan" onClick={() => cancelPlan(dir, message.id)}>
              Cancelar
            </button>
          )}
          {(message.status === 'error' || message.status === 'cancelled') && !busy && (
            <button type="button" data-action="orch-retry" onClick={() => void retryPlan(dir, message.id)}>
              Reintentar
            </button>
          )}
        </span>
      </div>
      {changing && message.status === 'proposed' && plan && (
        <div className="orch-plan-change">
          <ModelPicker models={models} model={plan.model} effort={plan.effort} part="change" onChange={(m, e) => changePlanModel(dir, message.id, m, e)} />
        </div>
      )}
      {open && plan && (
        <div className="orch-plan-details" data-settled={settled || undefined}>
          <Answer text={plan.task} dir={null} />
          {plan.files.length > 0 && <p className="orch-muted orch-files">Archivos: {plan.files.join(', ')}</p>}
        </div>
      )}
      {message.error && <AiErrorBox code={message.error.code as AiErrorCode} message={message.error.message} />}
    </div>
  );
}

/** "Leyó 2 archivos, editó 1" (live: what it is doing now), expandable to every step. */
function ActivityLine({ dir, message }: { dir: string; message: Extract<OrchMessage, { kind: 'run' }> }) {
  const [open, setOpen] = useState(false);
  const running = message.status === 'running';
  const summary = activitySummary(message.activity);
  const label = running ? activityNow(message.activity, message.text) : summary || (message.status === 'done' ? 'Sin cambios en archivos ni comandos' : '');
  const prefix = message.resumed ? 'Continuación' : null;
  return (
    <div className="orch-activity-block" data-open={open || undefined}>
      <div className="orch-activity-line" data-orch="activity-line">
        <button type="button" className="orch-activity-toggle" aria-expanded={open} disabled={message.activity.length === 0} onClick={() => setOpen((o) => !o)}>
          {running ? (
            <LoaderCircle className="orch-activity-state spin" aria-label="trabajando" />
          ) : message.status === 'done' ? (
            <Check className="orch-activity-state" data-tone="ok" aria-label="terminada" />
          ) : message.status === 'error' ? (
            <TriangleAlert className="orch-activity-state" data-tone="error" aria-label="falló" />
          ) : (
            <CircleSlash className="orch-activity-state" aria-label="cancelada" />
          )}
          {prefix && <span className="orch-muted">{prefix} ·</span>}
          <span className="orch-activity-text" data-orch="activity-summary">
            {label}
            {message.status === 'cancelled' && (label ? ' · cancelada' : 'Cancelada')}
          </span>
          {running && summary && <span className="orch-muted orch-activity-sofar">{summary}</span>}
          {message.activity.length > 0 && (open ? <ChevronDown className="orch-chevron" aria-hidden="true" /> : <ChevronRight className="orch-chevron" aria-hidden="true" />)}
        </button>
        <span className="orch-muted orch-activity-model">
          {message.model}
          {message.effort ? ` · ${message.effort}` : ''}
        </span>
        {running && (
          <button type="button" className="orch-mini" data-action="orch-cancel-run" onClick={() => cancelBusy(dir)}>
            Detener
          </button>
        )}
      </div>
      {open && (
        <ul className="orch-activity" data-orch="activity">
          {message.activity.map((a) => {
            const Icon = ACTION_ICON[a.action];
            const isFile = FILE_ACTIONS.includes(a.action) && a.target;
            return (
              <li key={a.id} data-action={a.action} data-ok={a.ok === null ? 'running' : String(a.ok)} title={a.tool}>
                <Icon className="orch-activity-icon" aria-hidden="true" />
                <span className="orch-activity-verb">{ACTION_LABEL[a.action]}</span>
                {isFile ? (
                  <button type="button" className="md-path orch-activity-target" data-code="" title={`Mostrar ${a.target} en el explorador`} onClick={() => void revealInExplorer(resolvePath(dir, a.target))}>
                    {a.target}
                  </button>
                ) : (
                  <code className="orch-activity-target">{a.target || a.tool}</code>
                )}
                {a.ok === false && <X className="orch-activity-fail" aria-label="falló" />}
              </li>
            );
          })}
        </ul>
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
        {file.binary ? (
          <span className="orch-muted">binario</span>
        ) : (
          <span className="orch-diff-counts">
            <span data-tone="add">+{file.additions}</span> <span data-tone="del">−{file.deletions}</span>
          </span>
        )}
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

/** The files a task changed: one line, expandable to each file's diff. */
function Changes({ diff }: { diff: TaskDiff }) {
  const [open, setOpen] = useState(false);
  if (!diff.git) {
    return diff.touched.length ? <p className="orch-muted orch-changes-plain">Sin git no hay diff. Archivos editados: {diff.touched.join(', ')}</p> : null;
  }
  if (!diff.files.length) return null;
  const add = diff.files.reduce((n, f) => n + f.additions, 0);
  const del = diff.files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="orch-diff" data-orch="diff" data-open={open || undefined}>
      <button type="button" className="orch-changes" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="orch-chevron" aria-hidden="true" /> : <ChevronRight className="orch-chevron" aria-hidden="true" />}
        Cambios en {diff.files.length} {diff.files.length === 1 ? 'archivo' : 'archivos'}
        <span className="orch-diff-counts">
          <span data-tone="add">+{add}</span> <span data-tone="del">−{del}</span>
        </span>
      </button>
      {open && diff.files.map((f) => <DiffView key={f.path} file={f} />)}
    </div>
  );
}

/** A worker's answer, wide: activity in one line, the summary in markdown, changes and usage. */
function RunResponse({ dir, base, message, busy }: { dir: string; base: string; message: Extract<OrchMessage, { kind: 'run' }>; busy: boolean }) {
  const allowable = message.denials.some((d) => d.allow.length > 0);
  const stale = message.agentsStale;
  return (
    <div className="orch-response" data-orch="run" data-status={message.status} data-id={message.id}>
      <ActivityLine dir={base} message={message} />
      {message.result && (
        <div className="orch-answer" data-orch="result">
          <Answer text={message.result} dir={base} />
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
      {stale?.status === 'offered' && (
        <div className="orch-question" role="group" data-orch="agents-stale">
          <Answer text={`Esta tarea dejó \`AGENTS.md\` desactualizado: ${stale.reason}`} dir={base} className="md orch-stale-text" />
          <div className="orch-actions">
            <button type="button" className="primary" data-action="orch-update-agents" disabled={busy} onClick={() => void updateAgentsMd(dir, message.id)}>
              Actualizar AGENTS.md…
            </button>
            <button type="button" data-action="orch-dismiss-agents" onClick={() => dismissAgentsStale(dir, message.id)}>
              Ignorar
            </button>
          </div>
        </div>
      )}
      {message.diff && <Changes diff={message.diff} />}
      {(message.usage || message.sent) && (
        <div className="orch-foot">
          {message.usage && (
            <span data-orch="usage" title={usageDetail(message.usage, message.resumed ? 'Continuación de la tarea' : 'Tarea')}>
              {usageShort(message.usage)}
            </span>
          )}
          {message.sent && (
            <button type="button" className="ai-link" data-action="orch-sent" onClick={() => showSent(message.sent)}>
              Ver qué se envió
            </button>
          )}
        </div>
      )}
    </div>
  );
}
