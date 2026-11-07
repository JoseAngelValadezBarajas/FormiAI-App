import { BadgeV2, ButtonV2, CardV2 } from '@corefoundry-labs/forge-ui';
import './observatory.css';

export type ModelOption = { id: string; label: string; experimental: boolean; available: boolean; reason: string; confidence: number };

/**
 * Shows the chosen approved video before anything runs. Watching it never starts an analysis: the only
 * way to start one is the explicit button below the player.
 */
export function ReadyToAnalyze({ source, model, starting, onAnalyze }: {
  source: string; model?: ModelOption; starting: boolean; onAnalyze: () => void;
}) {
  const blocked = !model || !model.available;
  return (
    <section className="obs-ready" aria-label="Ready to analyze">
      <CardV2 as="div" variant="outlined" header={<div className="obs-card-head"><span className="obs-label">SOURCE VIDEO</span><span className="obs-muted">{source}</span></div>}>
        <div className="obs-stage">
          <video key={source} src={`/api/input-videos/${encodeURIComponent(source)}/video`} controls preload="metadata" />
        </div>
        <div className="obs-ready-actions">
          <ButtonV2 variant="primary" disabled={blocked || starting} onClick={onAnalyze}>
            {starting ? 'Iniciando…' : 'Analizar video'}
          </ButtonV2>
          {model && <BadgeV2 tone="neutral" variant="subtle">MODEL · {model.id} · conf {model.confidence.toFixed(2)}</BadgeV2>}
          {model?.experimental && <BadgeV2 tone="warning" variant="subtle">EXPERIMENTAL</BadgeV2>}
          <span className="obs-muted">{blocked ? (model ? `${model.id} no disponible: ${model.reason}` : 'Sin modelo disponible') : 'El análisis solo empieza al pulsar el botón.'}</span>
        </div>
      </CardV2>
    </section>
  );
}
