// Builds the synthetic sync clip: 640x360, 24 fps, 120 frames, pts = n/24 exactly.
// Every frame carries its own index as a 10-bit barcode (16 px squares, LSB first, top-left) and,
// when a font is available, as text. The barcode is what tests decode from the PRESENTED pixels.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const FRAMES = 120;
export const FPS = 24;
export const clipPath = resolve(process.cwd(), 'test-results', 'sync', 'sync.mp4') // run from frontend/;

export function ensureClip() {
  if (existsSync(clipPath)) return clipPath;
  mkdirSync(dirname(clipPath), { recursive: true });
  const bits = Array.from({ length: 10 }, (_, b) =>
    `drawbox=x=${b * 16}:y=0:w=16:h=16:color=white:t=fill:enable='gte(mod(floor(n/${2 ** b}),2),1)'`);
  const base = [`color=c=0x2f3931:s=640x360:r=${FPS}`, 'drawbox=x=0:y=0:w=160:h=16:color=black:t=fill', ...bits];
  const text = "drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='%{eif\:n\:d}':fontsize=96:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2";
  for (const filters of [[...base, text], base]) {
    try {
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', filters.join(','), '-frames:v', String(FRAMES),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '10', '-g', '12', '-movflags', '+faststart', clipPath]);
      return clipPath;
    } catch (error) { if (filters === base) throw error; }
  }
}
