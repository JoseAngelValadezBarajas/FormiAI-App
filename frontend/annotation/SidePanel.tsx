import { BadgeV2, ButtonV2, CardV2, KbdV2, ToggleButtonV2 } from '@corefoundry-labs/forge-ui';
import { trackLabel } from '../observatory/model';
import type { Shown } from '../observatory/correctionsModel';
import type { ExportManifest, QueueItem, Strategy } from '../observatory/useCorrections';

const REASON: Record<string, string> = { uncertain: 'incierto', coverage: 'cobertura' };
const STATUS_LABEL: Record<Shown['status'], string> = { untouched: 'SIN REVISAR', confirmed: 'CONFIRMADA', rejected: 'RECHAZADA', adjusted: 'AJUSTADA', added: 'AÑADIDA' };
const idLabel = (track: number | null) => (track === null ? 'sin P-ID' : trackLabel(track));
const size = ([x1, y1, x2, y2]: Shown['box']) => `${Math.round(x2 - x1)}×${Math.round(y2 - y1)} px`;

export function BoxList({ boxes, selectedKey, editable, ready, onSelect, onDecide, onClear }: {
  boxes: Shown[]; selectedKey: string | null; editable: boolean; ready: boolean;
  onSelect: (key: string) => void; onDecide: (kind: 'confirm' | 'reject') => void; onClear: () => void;
}) {
  const selected = boxes.find(item => item.key === selectedKey);
  return (
    <CardV2 as="section" variant="outlined" aria-label="Cajas del frame" header={<div className="ann-card-head"><span className="ann-label">CAJAS DEL FRAME</span><span className="ann-dim">{boxes.length}</span></div>}>
      {boxes.length === 0 && <p className="ann-dim">Este frame no tiene cajas.</p>}
      <ul className="ann-boxes">
        {boxes.map(item => (
          <li key={item.key}>
            <button type="button" className="ann-box-row" data-status={item.status} aria-pressed={item.key === selectedKey} onClick={() => onSelect(item.key)}>
              <span className="ann-stripe" aria-hidden="true" />
              <span className="ann-box-info">
                <strong>{item.model ? idLabel(item.model.track_id) : 'Nueva'}</strong>
                <small>{item.model ? `conf ${item.model.confidence.toFixed(2)} · ${size(item.box)}` : `dibujada por usted · ${size(item.box)}`}</small>
              </span>
              <span className="ann-box-status">{STATUS_LABEL[item.status]}</span>
            </button>
            {item.key === selectedKey && (
              <div className="ann-box-actions" role="group" aria-label="Decisión sobre la caja seleccionada">
                <ButtonV2 size="sm" variant="secondary" disabled={!editable || !ready || !selected?.model} onClick={() => onDecide('confirm')}>Confirmar</ButtonV2>
                <KbdV2 size="sm">C</KbdV2>
                <ButtonV2 size="sm" variant="danger" disabled={!editable || !ready || !selected?.model} onClick={() => onDecide('reject')}>Rechazar</ButtonV2>
                <KbdV2 size="sm">R</KbdV2>
                <ButtonV2 size="sm" variant="ghost" disabled={!editable || !selected?.annotationId} onClick={onClear}>Quitar decisión</ButtonV2>
              </div>
            )}
          </li>
        ))}
      </ul>
    </CardV2>
  );
}

export function QueuePanel({ queue, strategy, frame, onStrategy, onGo, onStep }: {
  queue: QueueItem[]; strategy: Strategy; frame: number; onStrategy: (strategy: Strategy) => void; onGo: (frame: number) => void; onStep: (direction: 1 | -1) => void;
}) {
  return (
    <CardV2 as="section" variant="outlined" aria-label="Cola de revisión" header={<div className="ann-card-head"><span className="ann-label">COLA DE REVISIÓN</span><span className="ann-dim">{queue.length} frames</span></div>}>
      <div role="group" aria-label="Estrategia de la cola" className="ann-chips">
        {(['uncertain', 'coverage'] as const).map(which => (
          <ToggleButtonV2 key={which} size="sm" pressed={strategy === which} onPressedChange={() => onStrategy(which)}>{which === 'uncertain' ? 'Inciertos' : 'Cobertura'}</ToggleButtonV2>
        ))}
      </div>
      <p className="ann-dim">{strategy === 'uncertain' ? 'Frames con cajas de baja confianza, separados entre sí.' : 'Frames repartidos por todo el video para encontrar hormigas omitidas.'}</p>
      <ol className="ann-queue">
        {queue.slice(0, 40).map(item => (
          <li key={item.frame_index}>
            <button type="button" aria-current={item.frame_index === frame} onClick={() => onGo(item.frame_index)}>
              <span>Frame {item.frame_index}</span>
              <small>{REASON[item.reason] ?? item.reason}{item.score ? ` ${item.score.toFixed(2)}` : ''}</small>
            </button>
          </li>
        ))}
      </ol>
      {queue.length === 0 && <p className="ann-dim">No quedan frames en esta cola.</p>}
      <div className="ann-queue-nav">
        <ButtonV2 size="sm" variant="secondary" onClick={() => onStep(-1)}>Anterior</ButtonV2><KbdV2 size="sm">P</KbdV2>
        <span className="ann-grow" />
        <ButtonV2 size="sm" variant="secondary" onClick={() => onStep(1)}>Siguiente</ButtonV2><KbdV2 size="sm">N</KbdV2>
      </div>
    </CardV2>
  );
}

export function ExportsPanel({ sessionId, counts, completeCount, exported, notice }: {
  sessionId: string; counts: { confirm: number; reject: number; adjust: number; add: number }; completeCount: number; exported: ExportManifest[]; notice: string;
}) {
  const last = exported[exported.length - 1];
  return (
    <CardV2 as="section" variant="outlined" aria-label="Exportaciones" header={<div className="ann-card-head"><span className="ann-label">PROGRESO Y EXPORTACIONES</span><BadgeV2 tone="neutral" variant="subtle" size="sm">inmutables</BadgeV2></div>}>
      <p className="ann-dim">{completeCount} frames completos · {counts.confirm} confirmadas · {counts.reject} rechazadas · {counts.adjust} ajustadas · {counts.add} añadidas</p>
      {notice && <p className="ann-dim" role="status">{notice}</p>}
      {last
        ? (
          <div aria-label="Última exportación">
            <p><strong>{last.export_id}</strong> <span className="ann-dim">· {last.counts.annotations} anotaciones · {last.counts.complete_frames} frames completos</span></p>
            <p className="ann-links">{(['manifest.json', 'annotations.jsonl', 'frames.jsonl'] as const).map(name => (
              <a key={name} href={`/api/sessions/${sessionId}/exports/${last.export_id}/${name}`} download>{name}</a>
            ))}</p>
          </div>
        )
        : <p className="ann-dim">Todavía no hay exportaciones.</p>}
    </CardV2>
  );
}
