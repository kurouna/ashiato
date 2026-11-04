/**
 * Renders the app icons from build/icon.svg and build/tray.svg.
 *
 *   build/icon.png                 1024x1024 - electron-builder derives icon.ico (and icns) from it
 *   resources/icons/icon.png       256x256   - the window and taskbar icon at runtime
 *   resources/icons/tray-N.png     N = 16, 20, 24, 32 - notification-area icon at 100-200 % scaling
 *   resources/icons/tray-paused-N.png          - the same in slate while recording is paused
 *
 * The SVGs are the only hand-edited sources; run this after changing them:
 *   npm run gen:icon
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const icon = readFileSync(join(ROOT, 'build', 'icon.svg'), 'utf8');
const tray = readFileSync(join(ROOT, 'build', 'tray.svg'), 'utf8');

const targets = [
  { out: join(ROOT, 'build', 'icon.png'), size: 1024, svg: icon },
  { out: join(ROOT, 'resources', 'icons', 'icon.png'), size: 256, svg: icon },
  ...[16, 20, 24, 32].flatMap((size) => [
    { out: join(ROOT, 'resources', 'icons', `tray-${size}.png`), size, svg: tray.replace('FILL', '#f5c97a') },
    { out: join(ROOT, 'resources', 'icons', `tray-paused-${size}.png`), size, svg: tray.replace('FILL', '#94a3b8') },
  ]),
];

for (const { out, size, svg } of targets) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  console.log(`wrote ${out} (${size}x${size}, ${(png.length / 1024).toFixed(1)} kB)`);
}
