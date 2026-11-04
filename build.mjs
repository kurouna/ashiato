import * as esbuild from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');
fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist/renderer', { recursive: true });
for (const f of ['index.html', 'memo.html', 'style.css']) fs.copyFileSync(`src/renderer/${f}`, `dist/renderer/${f}`);

const common = { bundle: true, sourcemap: !prod, minify: prod, logLevel: 'info', target: 'es2023' };
const configs = [
  { ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife' },
  { ...common, entryPoints: ['src/renderer/memo.ts'], outfile: 'dist/renderer/memo.js', platform: 'browser', format: 'iife' },
];

if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
