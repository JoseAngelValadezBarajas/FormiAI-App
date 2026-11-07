import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertV2, BadgeV2, ButtonV2, KbdV2, TextInputV2, ToggleButtonV2, ToolbarSeparatorV2, ToolbarV2 } from '@corefoundry-labs/forge-ui';
import { BoxPlus, Eye, Hand, Maximize, Minus, Plus, Pointer, Tag, Undo, ZoomIn } from '@corefoundry-labs/forge-icons';
import { formatClock, trackLabel } from '../observatory/model';
import { neighbour, shownBoxes, stepFrame, summary, type Box, type Shown } from '../observatory/correctionsModel';
import { useCorrections } from '../observatory/useCorrections';
import { Minimap } from './Minimap';
import { ShortcutsDialog } from './ShortcutsDialog';
import { BoxList, ExportsPanel, QueuePanel } from './SidePanel';
import { Stage, type Tool } from './Stage';
import { Timeline } from './Timeline';
import { buildLanes } from './timelineModel';
import { ZOOM_STEP, actualPixels, fitView, zoomCentre, zoomPercent, type Stage as StageSize, type View } from './viewport';

const idLabel = (track: number | null) => (track === null ? 'sin P-ID' : trackLabel(track));
const STATUS_ES = { untouched: 'sin revisar', confirmed: 'confirmada', rejected: 'rechazada', adjusted: 'ajustada', added: 'añadida' } as const;
const LEGEND = [['confirmada', 'confirm'], ['rechazada', 'reject'], ['ajustada', 'adjust'], ['añadida', 'add'], ['sin revisar', 'none']] as const;

/**
 * The annotation workspace for one analysed video: clean source video with editable boxes, a timeline of what has
 * been reviewed, and the box list, review queue and exports. Every change goes to the server first, so what is on
 * screen is always what would be exported.
 */
export function Workspace({ sessionId }: { sessionId: string }) {
  const c = useCorrections(sessionId);
  const [frame, setFrame] = useState(0);
  const [shownFrame, setShownFrame] = useState(-1);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [view, setView] = useState<View>({ zoom: 1, cx: 0, cy: 0 });
  const [stage, setStage] = useState<StageSize>({ width: 0, height: 0 });
  const [showBoxes, setShowBoxes] = useState(true);
  const [showIds, setShowIds] = useState(true);
  const [space, setSpace] = useState(false);
  const [help, setHelp] = useState(false);
  const [goto, setGoto] = useState('0');
  const [notice, setNotice] = useState('');

  const source = c.review?.source;
  const size = useMemo(() => (source ? { width: source.width, height: source.height, fps: source.fps } : undefined), [source]);
  const fps = source?.fps ?? 0;
  const frameCount = source?.frame_count ?? 0;
  const editable = Boolean(source?.verified);
  const ready = shownFrame === frame && shownFrame >= 0;
  const onSize = useCallback((next: StageSize) => setStage(next), []);

  useEffect(() => { if (source) setView(fitView(source)); }, [source]);
  useEffect(() => { setSelected(null); setGoto(String(frame)); }, [frame]);

  const frameAnnotations = useMemo(() => c.annotations.filter(a => a.frame_index === shownFrame), [c.annotations, shownFrame]);
  const shown = useMemo(() => (c.review && shownFrame >= 0 ? shownBoxes(c.review.frames[shownFrame] ?? [], frameAnnotations) : []), [c.review, frameAnnotations, shownFrame]);
  const selectedBox = shown.find(item => item.key === selected);
  const counts = summary(c.annotations);
  const lanes = useMemo(() => buildLanes(c.complete, c.annotations, c.queue), [c.complete, c.annotations, c.queue]);
  const completeHere = c.complete.has(shownFrame);

  const step = (delta: number) => setFrame(value => stepFrame(value, delta, frameCount));
  const go = (target: number | undefined) => { if (target !== undefined) setFrame(target); };
  const stepQueue = (direction: 1 | -1) => go(neighbour(c.queue, frame, direction));

  const decide = (kind: 'confirm' | 'reject') => {
    if (!editable || !selectedBox?.model || !ready) return;
    void c.create({ kind, frame_index: shownFrame, target: { bbox: selectedBox.model.bbox } });
  };
  const clearDecision = () => {
    if (!editable) return;
    const existing = c.annotations.find(a => a.id === selectedBox?.annotationId);
    if (existing) void c.remove(existing).then(() => { if (existing.kind === 'add') setSelected(null); });
  };
  const toggleComplete = () => { if (editable && ready) void c.setFrameComplete(shownFrame, !c.complete.has(shownFrame)); };
  const adjust = async (item: Shown, box: Box) => {
    const existing = c.annotations.find(a => a.id === item.annotationId);
    if (existing && (existing.kind === 'add' || existing.kind === 'adjust')) await c.move(existing, box);
    else if (item.model) await c.create({ kind: 'adjust', frame_index: shownFrame, target: { bbox: item.model.bbox }, bbox: box });
  };
  const add = async (box: Box) => {
    const made = await c.create({ kind: 'add', frame_index: shownFrame, bbox: box });
    if (made) { setSelected(`a:${made.id}`); setTool('select'); }
  };
  const runExport = async () => {
    const manifest = await c.exportNow();
    setNotice(manifest ? `Exportación ${manifest.export_id} creada.` : '');
  };
  const commitGoto = () => {
    const value = Number.parseInt(goto, 10);
    if (Number.isFinite(value)) setFrame(stepFrame(value, 0, frameCount)); else setGoto(String(frame));
  };

  const zoomBy = (factor: number) => size && setView(current => zoomCentre(current, factor, stage, size));
  const fit = () => size && setView(fitView(size));
  const realSize = () => size && setView(current => actualPixels(current, stage, size));
  const chooseTool = (next: Tool) => { if (editable || next === 'pan' || next === 'zoom') setTool(next); };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (help || event.defaultPrevented || event.altKey || event.metaKey) return;
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const interactive = Boolean(target.closest('button, a, [role="button"]'));
      const key = event.key.toLowerCase();
      const handled = () => event.preventDefault();
      if (event.ctrlKey) { if (key === 'z') { handled(); if (editable) void c.undoLast(); } return; }
      if (event.key === ' ') { if (!interactive) { handled(); setSpace(true); } return; }
      if (key === 'arrowright' || key === 'arrowleft') { handled(); step((key === 'arrowright' ? 1 : -1) * (event.shiftKey ? 10 : 1)); }
      else if (key === 'n') { handled(); stepQueue(1); }
      else if (key === 'p') { handled(); stepQueue(-1); }
      else if (key === 'g') { handled(); document.getElementById('ann-goto')?.focus(); }
      else if (key === 'v') { handled(); chooseTool('select'); }
      else if (key === 'a') { handled(); if (editable) setTool(value => (value === 'add' ? 'select' : 'add')); }
      else if (key === 'h') { handled(); chooseTool('pan'); }
      else if (key === 'z') { handled(); chooseTool('zoom'); }
      else if (key === 'b') { handled(); setShowBoxes(value => !value); }
      else if (key === 'i') { handled(); setShowIds(value => !value); }
      else if (key === '0') { handled(); fit(); }
      else if (key === '1') { handled(); realSize(); }
      else if (key === '+' || key === '=') { handled(); zoomBy(ZOOM_STEP); }
      else if (key === '-') { handled(); zoomBy(1 / ZOOM_STEP); }
      else if (key === '?') { handled(); setHelp(true); }
      else if (key === 'escape') { handled(); setTool('select'); setSelected(null); }
      else if (key === 'c') { handled(); decide('confirm'); }
      else if (key === 'r') { handled(); decide('reject'); }
      else if (key === 'f') { handled(); toggleComplete(); }
      else if (key === 'delete' || key === 'backspace') { handled(); clearDecision(); }
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === ' ') setSpace(false); };
    const release = () => setSpace(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', release); };
  });

  if (c.error && !c.review) {
    return (
      <section className="ann-page" aria-label="Espacio de anotación">
        <AlertV2 tone="error" title="No se puede abrir la anotación" description={c.error} />
        <p><a href="#/anotacion">← Volver a los videos</a></p>
      </section>
    );
  }
  if (!c.review || !source || !size) return <section className="ann-page" aria-label="Espacio de anotación"><p className="ann-dim">Cargando análisis…</p></section>;

  const lastExport = c.exported[c.exported.length - 1];
  const status = selectedBox
    ? `Seleccionada: ${selectedBox.model ? idLabel(selectedBox.model.track_id) : 'caja añadida'} (${STATUS_ES[selectedBox.status]})`
    : tool === 'add' ? 'Arrastre sobre el video para dibujar una hormiga que falta.'
      : tool === 'pan' ? 'Arrastre para desplazar la vista.'
        : tool === 'zoom' ? 'Clic para acercar; Shift y clic para alejar; también la rueda.'
          : 'Haga clic en una caja para seleccionarla; arrástrela o use sus esquinas para ajustarla.';

  return (
    <section className="ann-workspace" aria-label="Espacio de anotación">
      <div className="ann-workbar">
        <a className="ann-back" href="#/anotacion">← Videos</a>
        <strong className="ann-work-name">{source.name}</strong>
        {c.review.model && <BadgeV2 tone={c.review.model.experimental ? 'warning' : 'neutral'} variant="subtle">{c.review.model.id}{c.review.model.experimental ? ' · EXPERIMENTAL' : ''}</BadgeV2>}
        <BadgeV2 tone={source.verified ? 'primary' : 'error'} variant="subtle">{source.verified ? '✓ VIDEO VERIFICADO' : '! NO COINCIDE'}</BadgeV2>
        <span className="ann-dim">{c.complete.size} / {frameCount} frames completos · {frameCount ? Math.round((c.complete.size / frameCount) * 100) : 0} %</span>
        <span className="ann-grow" />
        <ButtonV2 size="sm" variant="secondary" iconStart={<Undo size={16} />} disabled={!editable || !c.canUndo} onClick={() => void c.undoLast()}>Deshacer</ButtonV2>
        <KbdV2 size="sm">Ctrl Z</KbdV2>
        <ButtonV2 size="sm" variant="primary" disabled={!editable || (c.annotations.length === 0 && c.complete.size === 0)} onClick={() => void runExport()}>Exportar correcciones</ButtonV2>
        <ButtonV2 size="sm" variant="ghost" aria-label="Atajos de teclado" onClick={() => setHelp(true)}><KbdV2 size="sm">?</KbdV2></ButtonV2>
      </div>
      {!source.verified && <AlertV2 tone="error" title="Solo lectura" description="El video fuente no está disponible o no coincide con el analizado (SHA-256): la corrección está bloqueada." />}
      {c.error && <AlertV2 tone="error" title="No se pudo completar la acción" description={c.error} />}

      <div className="ann-main">
        <ToolbarV2 aria-label="Herramientas" orientation="vertical" className="ann-tools">
          <ToggleButtonV2 size="lg" aria-label="Seleccionar y mover (V)" title="Seleccionar y mover (V)" pressed={tool === 'select'} disabled={!editable} onPressedChange={() => chooseTool('select')} iconStart={<Pointer size={20} />} />
          <ToggleButtonV2 size="lg" aria-label="Añadir hormiga (A)" title="Añadir hormiga (A)" pressed={tool === 'add'} disabled={!editable} onPressedChange={() => setTool(value => (value === 'add' ? 'select' : 'add'))} iconStart={<BoxPlus size={20} />} />
          <ToggleButtonV2 size="lg" aria-label="Desplazar la vista (H)" title="Desplazar la vista (H)" pressed={tool === 'pan'} onPressedChange={() => chooseTool('pan')} iconStart={<Hand size={20} />} />
          <ToggleButtonV2 size="lg" aria-label="Zoom (Z)" title="Zoom (Z)" pressed={tool === 'zoom'} onPressedChange={() => chooseTool('zoom')} iconStart={<ZoomIn size={20} />} />
          <ToolbarSeparatorV2 />
          <ToggleButtonV2 size="lg" aria-label="Mostrar cajas (B)" title="Mostrar cajas (B)" pressed={showBoxes} onPressedChange={setShowBoxes} iconStart={<Eye size={20} />} />
          <ToggleButtonV2 size="lg" aria-label="Mostrar identificadores (I)" title="Mostrar identificadores (I)" pressed={showIds} onPressedChange={setShowIds} iconStart={<Tag size={20} />} />
        </ToolbarV2>

        <div className="ann-center">
          <Stage
            videoUrl={`/api/sessions/${sessionId}/source-video`} source={size} frame={frame} shownFrame={shownFrame} onShownFrame={setShownFrame}
            shown={shown} selectedKey={selected} tool={tool} spaceHeld={space} editable={editable} showBoxes={showBoxes} showIds={showIds}
            view={view} onView={setView} onSize={onSize} onSelect={setSelected} onAdjust={adjust} onAdd={add}
          >
            <div className="ann-hud ann-hud-tl" aria-live="polite">
              <span className="ann-chip">FRAME {ready ? shownFrame : '…'} / {frameCount - 1} · {formatClock(frame / fps)} · {shown.length} cajas</span>
              {completeHere && <BadgeV2 tone="primary" variant="solid" size="sm">✓ FRAME COMPLETO</BadgeV2>}
            </div>
            <div className="ann-hud ann-hud-tr" role="group" aria-label="Zoom">
              <ButtonV2 size="sm" variant="ghost" aria-label="Alejar" iconStart={<Minus size={16} />} onClick={() => zoomBy(1 / ZOOM_STEP)} />
              <span className="ann-chip" aria-label="Nivel de zoom">ZOOM {zoomPercent(view)} %</span>
              <ButtonV2 size="sm" variant="ghost" aria-label="Acercar" iconStart={<Plus size={16} />} onClick={() => zoomBy(ZOOM_STEP)} />
              <ButtonV2 size="sm" variant="ghost" iconStart={<Maximize size={16} />} onClick={fit}>Ajustar</ButtonV2>
              <ButtonV2 size="sm" variant="ghost" onClick={realSize}>100 %</ButtonV2>
            </div>
            <ul className="ann-legend" aria-label="Leyenda de colores">
              {LEGEND.map(([label, kind]) => <li key={kind} data-kind={kind}><span aria-hidden="true" />{label}</li>)}
            </ul>
            {view.zoom > 1 && <div className="ann-hud ann-hud-br"><Minimap source={size} stage={stage} view={view} shown={shown} onView={setView} /></div>}
          </Stage>
          <p className="ann-status" role="status">{status}</p>

          <div className="ann-timeline-card">
            <div className="ann-transport">
              <ButtonV2 size="sm" variant="secondary" onClick={() => step(-10)} aria-label="Retroceder 10 frames">« −10</ButtonV2>
              <ButtonV2 size="sm" variant="secondary" onClick={() => step(-1)} aria-label="Frame anterior">‹ −1</ButtonV2>
              <ButtonV2 size="sm" variant="secondary" onClick={() => step(1)} aria-label="Frame siguiente">+1 ›</ButtonV2>
              <ButtonV2 size="sm" variant="secondary" onClick={() => step(10)} aria-label="Avanzar 10 frames">+10 »</ButtonV2>
              <label className="ann-goto" htmlFor="ann-goto">Ir al frame
                <TextInputV2
                  id="ann-goto" size="sm" inputMode="numeric" value={goto} onChange={event => setGoto(event.target.value)}
                  onBlur={commitGoto} onKeyDown={event => { if (event.key === 'Enter') commitGoto(); }}
                />
              </label>
              <span className="ann-grow" />
              <ToggleButtonV2 size="sm" pressed={completeHere} disabled={!editable || !ready} onPressedChange={toggleComplete}>Frame completo</ToggleButtonV2>
              <KbdV2 size="sm">F</KbdV2>
            </div>
            <Timeline frameCount={frameCount} fps={fps} frame={frame} lanes={lanes} onSeek={setFrame} />
          </div>
        </div>

        <div className="ann-side">
          <BoxList boxes={shown} selectedKey={selected} editable={editable} ready={ready} onSelect={setSelected} onDecide={decide} onClear={clearDecision} />
          <QueuePanel queue={c.queue} strategy={c.strategy} frame={frame} onStrategy={which => void c.chooseStrategy(which)} onGo={setFrame} onStep={stepQueue} />
          <ExportsPanel sessionId={sessionId} counts={counts} completeCount={c.complete.size} exported={c.exported} notice={notice} />
        </div>
      </div>
      <ShortcutsDialog open={help} onOpenChange={setHelp} />
    </section>
  );
}
