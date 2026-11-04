// Bundles each test/*.test.ts with esbuild (same resolution as the app) and runs them with node:test.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = path.join('dist-test');
fs.rmSync(out, { recursive: true, force: true });
const entries = fs.readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => path.join('test', f));
await esbuild.build({ entryPoints: entries, outdir: out, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'warning' });
const files = fs.readdirSync(out).filter((f) => f.endsWith('.js')).map((f) => path.join(out, f));
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
