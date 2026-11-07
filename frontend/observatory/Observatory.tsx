import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { BadgeV2, ButtonV2, CardV2 } from '@corefoundry-labs/forge-ui';
import { frameAtTime } from '../progress';
import { timestampFromOffset } from '../timeline';
import './observatory.css';
import { analyzedFrames, binDetections, containRect, cursorRatio, formatClock, progressRatio, snapMediaTime, trackLabel } from './model';
import { useProgressiveStream, type ProgressState } from './useProgressiveStream';

type ObservatoryJob = { model?: { id: string; label: string; experimental: boolean; confidence: number }; id: string; source_name: string; source_video_url?: string; progress: ProgressState };

const number = new Intl.NumberFormat('en-US');
const accent = (element: Element) => getComputedStyle(element).getPropertyValue('--cf-v2-action-primary').trim() || '#6ce0b9';
const surface = (element: Element) => getComputedStyle(element).getPropertyValue('--cf-v2-surface').trim() || '#111d20';
const ink = (element: Element) => getComputedStyle(element).getPropertyValue('--cf-v2-on-surface').trim() || '#ffffff';

export function Observatory({ job, done, onClose, onStop, onEnd }: {
  job: ObservatoryJob; done: (sessionId: string) => void; onClose?: () => void;
  onStop?: () => Promise<unknown>; onEnd?: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { frames, progress, connected, gap, rate, completedSession, failure, cancelled } = useProgressiveStream(job.id, job.progress, done);
  const [stopping, setStopping] = useState(false);
  const ended = Boolean(failure || cancelled || completedSession);
  // Lets the page re-enable its controls once this analysis is no longer running.
  useEffect(() => { if (ended) onEnd?.(); }, [ended]);
  const [boxes, setBoxes] = useState(true);
  const [confidence, setConfidence] = useState(false);
  const [trackIds, setTrackIds] = useState(true);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const { fps } = progress;
  const total = analyzedFrames(progress.processed_through_frame, progress.frame_count);
  const length = duration || (fps && progress.frame_count ? progress.frame_count / fps : 0);
  const current = fps ? frameAtTime(frames, time, fps) : undefined;
  // Derived from local data, not from server progress: a frame is playable only once its result has
  // reached this client. It is recomputed on every render, so results arriving while paused lift it.
  const buffering = current === undefined;
  const bins = useMemo(
    () => binDetections(frames, progress.frame_count, progress.processed_through_frame),
    [frames, progress.frame_count, progress.processed_through_frame],
  );
  const peak = Math.max(1, ...bins.map(bin => bin.mean));

  // Media time of the last frame the browser presented since the latest seek. Right after playback stops,
  // the frame on screen can be one ahead of floor(currentTime * fps), so the overlay follows the presented frame.
  const presentedTime = useRef<number | null>(null);
  const draw = (at?: number) => {
    const element = video.current;
    const layer = canvas.current;
    if (!element || !layer || !fps) return;
    const box = element.getBoundingClientRect();
    const context = layer.getContext('2d');
    if (!context) return;
    const pixelWidth = Math.round(box.width * devicePixelRatio);
    const pixelHeight = Math.round(box.height * devicePixelRatio);
    if (layer.width !== pixelWidth || layer.height !== pixelHeight) {
      layer.width = pixelWidth;
      layer.height = pixelHeight;
      layer.style.width = `${box.width}px`;
      layer.style.height = `${box.height}px`;
    }
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.clearRect(0, 0, box.width, box.height);
    const result = frameAtTime(frames, at ?? presentedTime.current ?? element.currentTime, fps);
    const content = containRect(box.width, box.height, element.videoWidth, element.videoHeight);
    // Evidence for tests: which scientific frame the overlay was drawn for, and whether anything was drawn.
    layer.dataset.frameIndex = result ? String(result.frame_index) : '';
    layer.dataset.fps = String(fps);
    layer.dataset.drawn = String(boxes && Boolean(result) && Boolean(content));
    if (!boxes || !result || !content) return;
    const stroke = accent(layer);
    context.font = '600 10px Inter, system-ui, sans-serif';
    result.detections.forEach(detection => {
      const [x1, y1, x2, y2] = detection.bbox;
      const x = content.x + x1 * content.scale;
      const y = content.y + y1 * content.scale;
      context.strokeStyle = stroke;
      context.lineWidth = 1.6;
      context.strokeRect(x, y, (x2 - x1) * content.scale, (y2 - y1) * content.scale);
      const label = [trackIds ? trackLabel(detection.track_id) : '', confidence ? `${(detection.confidence * 100).toFixed(0)}%` : '']
        .filter(Boolean)
        .join(' ');
      if (!label) return;
      const width = context.measureText(label).width + 8;
      const top = Math.max(content.y, y - 14);
      context.fillStyle = surface(layer);
      context.fillRect(x, top, width, 14);
      context.fillStyle = stroke;
      context.fillText(label, x + 4, top + 10.5);
    });
    context.fillStyle = ink(layer);
  };

  const update = () => {
    const element = video.current;
    if (!element || !fps) return;
    setTime(element.currentTime);
    setPaused(element.paused);
    if (!frameAtTime(frames, element.currentTime, fps) && !element.paused) element.pause();
    draw();
  };

  useEffect(() => draw(), [frames, progress, boxes, confidence, trackIds, time]);
  useEffect(() => {
    const redraw = () => draw();
    window.addEventListener('resize', redraw);
    return () => window.removeEventListener('resize', redraw);
  }, [frames, progress, boxes, confidence, trackIds, time]);

  // Redraw for each frame the browser actually presents, using that frame's own media time, so a box
  // never outlives its frame between timeupdate events. Browsers without the API fall back to timeupdate.
  const presented = useRef<(mediaTime: number) => void>(() => {});
  presented.current = (reported: number) => {
    const element = video.current;
    if (!element || !fps) return;
    const mediaTime = snapMediaTime(reported, fps);
    presentedTime.current = mediaTime;
    if (!frameAtTime(frames, mediaTime, fps) && !element.paused) element.pause();
    draw(mediaTime);
  };
  useEffect(() => {
    const element = video.current;
    if (!element || typeof element.requestVideoFrameCallback !== 'function') return;
    let active = true;
    let handle = 0;
    const tick = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (!active) return;
      presented.current(metadata.mediaTime);
      handle = element.requestVideoFrameCallback(tick);
    };
    handle = element.requestVideoFrameCallback(tick);
    return () => { active = false; element.cancelVideoFrameCallback(handle); };
  }, [job.id]);

  const seek = (seconds: number) => {
    const element = video.current;
    if (!element || !length) return;
    element.currentTime = Math.max(0, Math.min(length, seconds));
  };
  const togglePlayback = () => {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => setPaused(true));
    else element.pause();
  };
  const onTimelineClick = (event: MouseEvent<HTMLDivElement>) => {
    // offsetX is relative to the clicked bin, so measure against the timeline itself.
    const bounds = event.currentTarget.getBoundingClientRect();
    seek(timestampFromOffset(event.clientX - bounds.left, bounds.width, length));
  };
  const onTimelineKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!fps || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
    event.preventDefault();
    // Step by frame index and land on the frame's centre: seeking to an exact boundary time may present
    // the previous frame, depending on the browser's own rounding.
    const index = Math.floor(snapMediaTime(video.current?.currentTime ?? time, fps) * fps + 1e-6);
    const last = Math.max(0, (progress.frame_count ?? index + 1) - 1);
    const target = Math.max(0, Math.min(last, index + (event.key === 'ArrowRight' ? 1 : -1)));
    seek((target + 0.5) / fps);
  };

  return (
    <section className="obs-screen" aria-label="Progressive observation">
      <div className="obs-heading">
        <div>
          <p className="obs-eyebrow">PROGRESSIVE OBSERVATION</p>
          <h1 className="obs-title">{job.source_name}</h1>
          <p className="obs-muted">Frames and detections arrive progressively · video synchronized by frame_index / FPS</p>
        </div>
        <div className="obs-badges">
          {job.model && <BadgeV2 tone="neutral" variant="subtle">MODEL · {job.model.id} · conf {job.model.confidence.toFixed(2)}</BadgeV2>}
          {job.model?.experimental && <BadgeV2 tone="warning" variant="subtle">EXPERIMENTAL</BadgeV2>}
          {failure ? <BadgeV2 tone="error" variant="subtle">● FAILED</BadgeV2>
            : cancelled ? <BadgeV2 tone="warning" variant="subtle">● CANCELLED</BadgeV2>
            : <BadgeV2 tone="primary" variant="subtle">● ANALYZING</BadgeV2>}
          {!ended && onStop && (
            <ButtonV2 variant="secondary" size="sm" disabled={stopping}
              onClick={() => { setStopping(true); onStop().catch(() => setStopping(false)); }}>
              {stopping ? 'Deteniendo…' : 'Detener análisis'}
            </ButtonV2>
          )}
        </div>
      </div>
      {cancelled && (
        <CardV2 as="section" variant="outlined" className="obs-failure" role="status" aria-label="Analysis cancelled"
          header={<span className="obs-label">ANALYSIS CANCELLED</span>}>
          <p className="obs-muted">The analysis was stopped. Frames received so far are not a complete analysis and were not saved as a session.</p>
          {onClose && <ButtonV2 variant="secondary" size="sm" onClick={onClose}>Cerrar</ButtonV2>}
        </CardV2>
      )}
      {failure && (
        <CardV2 as="section" variant="outlined" className="obs-failure" role="alert" aria-label="Analysis failed"
          header={<span className="obs-label">ANALYSIS FAILED</span>}>
          <p className="obs-muted">The analysis stopped before finishing. No result was produced for this run.</p>
          <details><summary>Details</summary><pre>{failure.slice(-1500)}</pre></details>
          {onClose && <ButtonV2 variant="secondary" size="sm" onClick={onClose}>Cerrar</ButtonV2>}
        </CardV2>
      )}

      <div className="obs-grid">
        <CardV2 as="section" variant="outlined" className="obs-viewport" aria-label="Scientific viewport"
          header={<div className="obs-card-head"><span className="obs-label">RECORDED VIDEO</span><BadgeV2 tone="primary" variant="subtle">PROGRESSIVE · DETECTIONS</BadgeV2></div>}>
          <div className="obs-stage">
            <video ref={video} src={job.source_video_url} onLoadedMetadata={() => { setDuration(video.current?.duration ?? 0); draw(); }}
              onTimeUpdate={() => update()} onSeeking={() => { presentedTime.current = null; }} onSeeked={() => update()} onPlay={() => update()} onPause={() => update()} />
            <canvas ref={canvas} aria-hidden="true" />
            <p className="obs-caption">SOURCE VIDEO · TRACKING PROVISIONAL · NO INTERPOLATION</p>
          </div>
          {buffering && <p className="obs-warning" role="status">Buffering: this frame has no result yet. Playback pauses and no predictions are drawn.</p>}
          <div className="obs-controls">
            <ButtonV2 variant="secondary" size="sm" onClick={togglePlayback} iconStart={<span aria-hidden="true">{paused ? '▶' : 'Ⅱ'}</span>}>{paused ? 'Play' : 'Pause'}</ButtonV2>
            <ButtonV2 variant={boxes ? 'primary' : 'secondary'} size="sm" aria-pressed={boxes} onClick={() => setBoxes(value => !value)} iconStart={<span aria-hidden="true">▣</span>}>Boxes</ButtonV2>
            <ButtonV2 variant={confidence ? 'primary' : 'secondary'} size="sm" aria-pressed={confidence} onClick={() => setConfidence(value => !value)}>Confidence</ButtonV2>
            <ButtonV2 variant={trackIds ? 'primary' : 'secondary'} size="sm" aria-pressed={trackIds} onClick={() => setTrackIds(value => !value)}>P-ID</ButtonV2>
            <span className="obs-clock">{formatClock(time)} / {formatClock(length)}</span>
          </div>
        </CardV2>

        <CardV2 as="section" variant="outlined" className="obs-instruments" aria-label="Instruments"
          header={<span className="obs-label">INSTRUMENTS</span>}>
          <div className="obs-instrument">
            <div className="obs-row"><span className="obs-micro">STREAM</span>
              <BadgeV2 tone={failure || cancelled || gap ? 'error' : connected ? 'primary' : 'warning'} variant="subtle">{failure || cancelled ? '● STOPPED' : gap ? '● BATCH GAP' : connected ? '● CONNECTED' : '● RECONNECTING'}</BadgeV2></div>
            <p className="obs-value">{number.format(total.analyzed)} / {total.total ? number.format(total.total) : '…'}</p>
            <p className="obs-muted">frames analyzed</p>
            {gap && <p className="obs-muted" role="alert">A progressive batch was skipped; frames after the gap were not shown live. Open Review to see the saved analysis.</p>}
            {completedSession && <ButtonV2 variant="primary" size="sm" onClick={() => done(completedSession)}>Abrir Review</ButtonV2>}
            <div className="obs-progress" role="progressbar" aria-label="Frames analyzed" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={Math.round(progressRatio(progress.processed_through_frame, progress.frame_count) * 100)}>
              <span style={{ width: `${progressRatio(progress.processed_through_frame, progress.frame_count) * 100}%` }} />
            </div>
          </div>
          <div className="obs-instrument">
            <p className="obs-micro">DET. / VISIBLE FRAME</p>
            <p className="obs-value obs-value-accent">{current ? current.detections.length : '—'}</p>
            <p className="obs-muted">observations (not unique ants)</p>
          </div>
          <div className="obs-instrument">
            <p className="obs-micro">ANALYSIS RATE</p>
            <p className="obs-value">{rate === undefined ? '—' : `${rate.toFixed(1)} FPS`}</p>
            <p className="obs-muted">{rate === undefined ? 'Not measured yet' : 'Observed in this session · not a benchmark'}</p>
          </div>
          <div className="obs-instrument-badge"><BadgeV2 tone="warning" variant="subtle">TRACKING PROVISIONAL</BadgeV2></div>
        </CardV2>

        <CardV2 as="section" variant="outlined" className="obs-temporal" aria-label="Temporal observation"
          header={<div className="obs-card-head"><span className="obs-label">TEMPORAL OBSERVATION</span><BadgeV2 tone="primary" variant="subtle">Frames analyzed</BadgeV2></div>}>
          <div className="obs-timeline" role="slider" tabIndex={0} aria-label="Video position" aria-valuemin={0} aria-valuemax={Math.round(length * 100) / 100}
            aria-valuenow={Math.round(time * 100) / 100} aria-valuetext={`${formatClock(time)} of ${formatClock(length)}`}
            onClick={onTimelineClick} onKeyDown={onTimelineKey}>
            <div className="obs-bins">
              {bins.map((bin, index) => (
                <span key={index} className={bin.analyzed ? 'obs-bin obs-bin-analyzed' : 'obs-bin'}
                  style={{ height: `${Math.max(8, (bin.mean / peak) * 100)}%` }} />
              ))}
            </div>
            <span className="obs-cursor" style={{ left: `${cursorRatio(time, length) * 100}%` }} />
          </div>
          <div className="obs-axis"><span>00:00</span><span>{formatClock(length / 2).slice(0, 5)}</span><span>{formatClock(length)}</span></div>
        </CardV2>

        <CardV2 as="section" variant="outlined" className="obs-integrity" aria-label="Data integrity"
          header={<span className="obs-label">DATA INTEGRITY</span>}>
          <ul>
            <li>Overlays matched by frame_index / FPS (sync not yet validated)</li>
            <li className="obs-muted">Buffer on missing results</li>
            <li className="obs-muted">Source and exports preserved</li>
            <li className="obs-warning">No inferred behavior classes</li>
          </ul>
        </CardV2>
      </div>
    </section>
  );
}
