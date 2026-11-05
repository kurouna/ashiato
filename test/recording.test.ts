import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { micAppName } from '../src/main/activeWindow';
import { reviewBreaks } from '../src/main/ai/prompts';
import { compressDay } from '../src/main/compress';
import { Recorder } from '../src/main/recorder';
import type { JournalEvent, Settings } from '../src/shared/types';

const at = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(2026, 10, 5, h, m).getTime();
};
const dayStart = new Date(2026, 10, 5).getTime();

test('no-input time is not described as being away; a locked screen is', () => {
  const out = compressDay([
    { t: 'idle', start: at('10:00'), end: at('10:20') },
    { t: 'idle', start: at('12:00'), end: at('13:00'), locked: true },
  ]);
  assert.match(out, /10:00–10:20 \(20分\) \(キー・マウス操作なし\)/);
  assert.match(out, /12:00–13:00 \(60分\) \(画面ロック・スリープ＝離席\)/);
  assert.ok(!/10:00.*離席/.test(out));
});

test('a call is listed alongside the windows used during it', () => {
  const out = compressDay([
    { t: 'call', start: at('10:00'), end: at('11:00'), app: 'Teams', title: '' },
    { t: 'window', start: at('10:05'), end: at('10:50'), app: 'Code', title: 'a.ts' },
  ]);
  assert.match(out, /10:00–11:00 \(60分\) 会議・通話に参加中 \[Teams\]（この間の前面ウィンドウと並行）/);
  assert.match(out, /10:05–10:50 .*\[Code\] a\.ts/);
});

test('merges and pulls are described as bringing work in', () => {
  const out = compressDay([{ t: 'gitop', ts: at('15:00'), repo: 'app', action: 'merge', text: "merge feature: Merge made by the 'ort' strategy." }]);
  assert.match(out, /15:00 git merge 「app」 .*（既存の変更の取り込み操作）/);
});

test('reviewBreaks relabels a "break" that the record shows as worked or in a meeting', () => {
  const events = [
    { t: 'window', start: at('10:00'), end: at('10:40'), app: 'Code' },
    { t: 'call', start: at('14:00'), end: at('15:00'), app: 'Teams' },
    { t: 'idle', start: at('12:00'), end: at('13:00'), locked: true },
  ];
  const blocks = reviewBreaks(
    [
      { start: '10:00', end: '10:45', category: 'break' },
      { start: '12:00', end: '13:00', category: 'break' },
      { start: '14:00', end: '15:00', category: 'break' },
      { start: '16:00', end: '17:00', category: 'coding' },
    ],
    events,
    dayStart,
  );
  assert.deepEqual(
    blocks.map((b) => b.category),
    ['other', 'break', 'meeting', 'coding'],
  );
});

test('micAppName maps registry names to short app names', () => {
  assert.equal(micAppName('MSTeams_8wekyb3d8bbwe'), 'Teams');
  assert.equal(micAppName('ms-teams.exe'), 'Teams');
  assert.equal(micAppName('Zoom.exe'), 'Zoom');
  assert.equal(micAppName('chrome.exe'), 'Chrome');
  assert.equal(micAppName('SomeRecorder.exe'), 'SomeRecorder');
});

// ---- file changes made by git are not the user's edits ----
function fakeStore(written: JournalEvent[], root: string) {
  const settings = { paused: false, watchFolders: [root], excludeKeywords: [], excludeApps: [], detectCalls: true } as unknown as Settings;
  return {
    getSettings: () => settings,
    append: (e: JournalEvent) => (written.push(e), '2026-11-05'),
    readDay: () => [],
    readCheckpoint: () => null,
    writeCheckpoint: () => {},
    clearCheckpoint: () => {},
  };
}

test('files rewritten by git merge are dropped, real edits are kept', { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashiato-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'me@example.com');
  git('config', 'user.name', 'me');
  fs.writeFileSync(path.join(root, 'base.txt'), 'base');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(root, `feat${n}.ts`), `feat ${n}`);
  git('add', '-A');
  git('commit', '-qm', 'feature work');
  git('checkout', '-q', 'main');

  const written: JournalEvent[] = [];
  const rec = new Recorder(fakeStore(written, root) as never);
  const r = rec as unknown as { refreshWatchers(): void; stop(): void };
  r.refreshWatchers();
  await new Promise((res) => setTimeout(res, 300));

  git('merge', '--no-ff', '-q', '-m', 'Merge feature', 'feature');
  await new Promise((res) => setTimeout(res, 5_500));
  const afterMerge = written.filter((e) => e.t === 'file').map((e) => (e as { path: string }).path);
  assert.deepEqual(afterMerge, [], `merge produced file events: ${afterMerge.join(', ')}`);

  fs.writeFileSync(path.join(root, 'feat1.ts'), 'edited by me');
  await new Promise((res) => setTimeout(res, 5_500));
  const afterEdit = written.filter((e) => e.t === 'file').map((e) => (e as { path: string }).path);
  assert.deepEqual(afterEdit, ['feat1.ts']);
  r.stop();
  fs.rmSync(root, { recursive: true, force: true });
});
