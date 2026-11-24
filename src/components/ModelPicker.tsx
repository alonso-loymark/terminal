import type { RankedModel } from '../lib/orchestratorModel';

/** A model (and its effort) among the ones the agent's CLI offers (the orchestrator). */
export function ModelPicker({
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
