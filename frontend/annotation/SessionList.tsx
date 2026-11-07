import { useMemo, useState } from 'react';
import { BadgeV2, ButtonV2, FeedbackStateV2, ProgressV2, StatisticV2, TableV2, TextInputV2, ToggleButtonV2, type TableV2Column } from '@corefoundry-labs/forge-ui';
import { Search } from '@corefoundry-labs/forge-icons';
import { FILTERS, filterCounts, formatInt, isUnverified, matches, progressOf, sortByActivity, totals, type Filter, type SessionItem } from './listModel';
import { annotationHref } from './route';
import { useAnnotationSessions } from './useAnnotationSessions';

const nameOf = (item: SessionItem) => (item.reviewable ? item.source.name : item.id);

function Corrections({ item }: { item: SessionItem }) {
  if (!item.reviewable) return <span className="ann-dim">—</span>;
  const { confirm, reject, adjust, add } = item.counts;
  if (confirm + reject + adjust + add === 0) return <span className="ann-dim">Sin correcciones</span>;
  return (
    <span className="ann-counts" aria-label={`${confirm} confirmadas, ${reject} rechazadas, ${adjust} ajustadas, ${add} añadidas`}>
      <span className="ann-c-confirm">✓ {formatInt(confirm)}</span>
      <span className="ann-c-reject">✕ {formatInt(reject)}</span>
      <span className="ann-c-adjust">↔ {formatInt(adjust)}</span>
      <span className="ann-c-add">+ {formatInt(add)}</span>
    </span>
  );
}

export function SessionList() {
  const { items, error, reload } = useAnnotationSessions();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const sorted = useMemo(() => (items ? sortByActivity(items) : []), [items]);
  const visible = useMemo(() => sorted.filter(item => matches(item, filter, query)), [sorted, filter, query]);
  const counts = useMemo(() => filterCounts(sorted, query), [sorted, query]);
  const summary = useMemo(() => totals(sorted), [sorted]);

  const columns: TableV2Column<SessionItem>[] = [
    {
      key: 'video', header: 'Video', width: '24%', rowHeader: true,
      cell: item => (
        <span className="ann-video">
          <strong>{nameOf(item)}</strong>
          <small>{item.reviewable ? `${item.source.width}×${item.source.height} · ${Math.round(item.source.fps)} fps · ${formatInt(item.frame_count)} frames` : item.reason}</small>
        </span>
      ),
    },
    {
      key: 'model', header: 'Modelo', width: '14%',
      cell: item => (item.reviewable && item.model
        ? <span className="ann-model"><BadgeV2 tone={item.model.experimental ? 'warning' : 'neutral'} variant="subtle">{item.model.id}</BadgeV2>{item.model.experimental && <small>experimental</small>}</span>
        : <span className="ann-dim">—</span>),
    },
    {
      key: 'progress', header: 'Avance de revisión', width: '20%',
      cell: item => (item.reviewable
        ? <span className="ann-progress"><ProgressV2 aria-label={`Frames completos de ${nameOf(item)}`} value={Math.round(progressOf(item) * 100)} /><small>{formatInt(item.complete_frames)} / {formatInt(item.frame_count)} frames</small></span>
        : <span className="ann-dim">—</span>),
    },
    { key: 'corrections', header: 'Correcciones', width: '17%', cell: item => <Corrections item={item} /> },
    {
      key: 'source', header: 'Video fuente', width: '12%',
      cell: item => (isUnverified(item)
        ? <BadgeV2 tone="error" variant="subtle">{item.reviewable ? '! NO COINCIDE' : '! SIN ANÁLISIS'}</BadgeV2>
        : <BadgeV2 tone="primary" variant="subtle">✓ VERIFICADO</BadgeV2>),
    },
    {
      key: 'export', header: 'Exportación', width: '13%',
      cell: item => (item.reviewable && item.last_export ? <span>{item.last_export.export_id}</span> : <span className="ann-dim">Sin exportar</span>),
    },
    {
      key: 'open', header: <span className="ann-sr">Acción</span>, align: 'end', width: '9rem',
      cell: item => {
        if (!item.reviewable) return <span className="ann-dim">No disponible</span>;
        const started = item.complete_frames > 0 || item.counts.confirm + item.counts.reject + item.counts.adjust + item.counts.add > 0;
        const unverified = isUnverified(item);
        const label = unverified ? 'Solo lectura' : started ? 'Abrir' : 'Empezar';
        return (
          <a className="ann-open" href={annotationHref(item.id)} aria-label={`${label}: ${nameOf(item)}`}>
            <ButtonV2 size="sm" variant={unverified ? 'secondary' : 'primary'} tabIndex={-1}>{label}</ButtonV2>
          </a>
        );
      },
    },
  ];

  return (
    <section className="ann-page" aria-labelledby="ann-list-title">
      <div className="ann-page-head">
        <div>
          <p className="ann-eyebrow">ANOTACIÓN</p>
          <h1 id="ann-list-title">Videos analizados</h1>
          <p className="ann-lead">Elija un análisis para corregir sus detecciones. Las correcciones se guardan aparte: nunca modifican el análisis ni el video.</p>
        </div>
        <div className="ann-stats">
          <StatisticV2 variant="card" label="videos analizados" value={formatInt(summary.videos)} />
          <StatisticV2 variant="card" label="cajas corregidas" value={formatInt(summary.corrections)} />
          <StatisticV2 variant="card" label="exportaciones" value={formatInt(summary.exports)} />
        </div>
      </div>

      <div className="ann-filters">
        <TextInputV2 size="sm" type="search" aria-label="Buscar por nombre de video" placeholder="Buscar por nombre de video…" value={query} onChange={event => setQuery(event.target.value)} />
        <div role="group" aria-label="Filtrar videos" className="ann-chips">
          {FILTERS.map(option => (
            <ToggleButtonV2 key={option.id} size="sm" pressed={filter === option.id} onPressedChange={() => setFilter(option.id)}>
              {`${option.label} · ${counts[option.id]}`}
            </ToggleButtonV2>
          ))}
        </div>
        <span className="ann-grow" />
        <span className="ann-dim">Ordenar: último abierto</span>
      </div>

      {error && (
        <FeedbackStateV2 state="error" title="No se pudo cargar la lista" description={error} actions={<ButtonV2 size="sm" variant="secondary" onClick={() => void reload()}>Reintentar</ButtonV2>} />
      )}
      {!error && !items && <FeedbackStateV2 state="loading" title="Cargando videos analizados…" />}
      {!error && items && (
        <TableV2<SessionItem>
          caption="Videos analizados" hideCaption columns={columns} rows={visible} getRowKey={item => item.id}
          empty={items.length === 0
            ? <span className="ann-empty"><Search size={18} aria-hidden="true" /> Todavía no hay videos analizados. Analice uno en Observatorio.</span>
            : <span className="ann-empty"><Search size={18} aria-hidden="true" /> Ningún video coincide con el filtro.</span>}
        />
      )}
      <p className="ann-note">«No coincide»: el video de la carpeta ya no es el que se analizó (SHA-256 distinto). Se puede revisar, pero no editar ni exportar hasta recuperar el original.</p>
    </section>
  );
}
