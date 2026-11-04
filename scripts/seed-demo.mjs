// Writes a fictional demo day into a profile folder so the UI can be tried without real data.
//   node scripts/seed-demo.mjs .demo-profile [YYYY-MM-DD]
//   ASHIATO_USER_DATA=.demo-profile npx electron .
import fs from 'node:fs';
import path from 'node:path';

const profile = path.resolve(process.argv[2] ?? '.demo-profile');
const date = process.argv[3] ?? new Date(Date.now() - 86400000).toLocaleDateString('sv-SE');
const dir = path.join(profile, 'journal');
fs.mkdirSync(dir, { recursive: true });

const [y, m, d] = date.split('-').map(Number);
const at = (hm) => {
  const [h, mi] = hm.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi).getTime();
};

const events = [];
const win = (s, e, app, title) => events.push({ t: 'window', start: at(s), end: at(e), app, title });
const idle = (s, e) => events.push({ t: 'idle', start: at(s), end: at(e) });
const file = (hm, p) => events.push({ t: 'file', ts: at(hm), path: p, root: 'C:/work/kanban-app' });
const commit = (hm, subject) => events.push({ t: 'commit', ts: at(hm), repo: 'kanban-app', hash: Math.random().toString(16).slice(2).padEnd(40, '0'), subject });
const memo = (hm, text) => events.push({ t: 'memo', ts: at(hm), text });

win('09:02', '09:20', 'slack', 'Slack - #team-frontend');
win('09:20', '09:31', 'chrome', 'Pull Request #128 · drag & drop の並び替え - GitHub - Google Chrome');
win('09:31', '09:58', 'Code', 'Board.tsx - kanban-app - Visual Studio Code');
win('09:58', '10:04', 'chrome', 'dnd-kit Sortable docs - Google Chrome');
win('10:04', '10:41', 'Code', 'useSortableColumns.ts - kanban-app - Visual Studio Code');
win('10:41', '10:46', 'WindowsTerminal', 'npm test - kanban-app');
win('10:46', '11:28', 'Code', 'Board.test.tsx - kanban-app - Visual Studio Code');
memo('11:05', '並び替え後に順序が保存されない原因は楽観的更新のロールバック漏れっぽい');
win('11:28', '11:34', 'WindowsTerminal', 'npm test - kanban-app');
win('11:34', '12:00', 'Teams', '定例ミーティング | Microsoft Teams');
idle('12:00', '13:02');
win('13:02', '13:15', 'Outlook', '受信トレイ - Outlook');
win('13:15', '13:52', 'Code', 'api/columns.ts - kanban-app - Visual Studio Code');
win('13:52', '14:10', 'chrome', 'localhost:5173 - Kanban - Google Chrome');
win('14:10', '14:47', 'Code', 'Board.tsx - kanban-app - Visual Studio Code');
win('14:47', '15:20', 'chrome', 'Pull Request #131 · 認証トークン更新 - GitHub - Google Chrome');
memo('15:18', '#131 は refresh の競合に注意とコメントした');
win('15:20', '15:31', 'slack', 'Slack - #team-frontend');
idle('15:31', '15:44');
win('15:44', '16:40', 'Code', 'docs/architecture.md - kanban-app - Visual Studio Code');
win('16:40', '17:22', 'Code', 'useSortableColumns.ts - kanban-app - Visual Studio Code');
win('17:22', '17:30', 'WindowsTerminal', 'git push - kanban-app');
win('17:30', '17:48', 'chrome', 'Pull Request #133 · カラム並び替えの永続化 - GitHub - Google Chrome');

['09:35', '09:44', '09:52'].forEach((t) => file(t, 'src/components/Board.tsx'));
['10:10', '10:22', '10:35'].forEach((t) => file(t, 'src/hooks/useSortableColumns.ts'));
['10:50', '11:10', '11:22'].forEach((t) => file(t, 'src/components/Board.test.tsx'));
['13:20', '13:41'].forEach((t) => file(t, 'src/api/columns.ts'));
['14:15', '14:33'].forEach((t) => file(t, 'src/components/Board.tsx'));
['15:50', '16:12', '16:31'].forEach((t) => file(t, 'docs/architecture.md'));
['16:45', '17:05'].forEach((t) => file(t, 'src/hooks/useSortableColumns.ts'));
commit('11:31', 'test: カラム並び替えのテストを追加');
commit('13:50', 'fix: 並び替え失敗時に楽観的更新をロールバック');
commit('16:38', 'docs: 状態管理の方針を追記');
commit('17:24', 'feat: カラム順序をサーバーに永続化');

events.sort((a, b) => (a.ts ?? a.start) - (b.ts ?? b.start));
fs.writeFileSync(path.join(dir, `${date}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

const blocks = [
  { start: '09:02', end: '09:31', title: 'チャット確認と PR #128 の確認', project: 'kanban-app', category: 'communication', summary: 'Slack の #team-frontend を確認し、drag & drop 並び替えの PR を読んだ。' },
  { start: '09:31', end: '11:34', title: 'カラム並び替えの実装とテスト', project: 'kanban-app', category: 'coding', summary: 'Board.tsx と useSortableColumns.ts を実装し、テストを追加してコミット。' },
  { start: '11:34', end: '12:00', title: '定例ミーティング', project: '', category: 'meeting', summary: 'Teams で定例。' },
  { start: '12:00', end: '13:02', title: '昼休み', project: '', category: 'break', summary: '離席。' },
  { start: '13:02', end: '14:47', title: '並び替え失敗時のロールバック修正', project: 'kanban-app', category: 'debugging', summary: 'api/columns.ts を修正し、ブラウザで動作確認。楽観的更新のロールバック漏れを修正してコミット。' },
  { start: '14:47', end: '15:31', title: 'PR #131 のレビュー', project: 'kanban-app', category: 'review', summary: '認証トークン更新の PR をレビューし、refresh の競合についてコメント。' },
  { start: '15:44', end: '16:40', title: 'アーキテクチャドキュメント更新', project: 'kanban-app', category: 'writing', summary: 'docs/architecture.md に状態管理の方針を追記。' },
  { start: '16:40', end: '17:48', title: 'カラム順序の永続化と PR 作成', project: 'kanban-app', category: 'coding', summary: 'useSortableColumns.ts を仕上げて push し、PR #133 を作成。' },
];
const report = `## 今日やったこと
- kanban-app のカラム並び替え機能を実装し、PR #133 を作成しました
- 並び替え失敗時に楽観的更新がロールバックされない不具合を修正しました
- PR #131（認証トークン更新）をレビューしました
- docs/architecture.md に状態管理の方針を追記しました

## 進捗・成果
- コミット 4 件（テスト追加、ロールバック修正、ドキュメント、順序の永続化）
- 並び替えのテストを追加し、リグレッションを検知できるようにしました

## 課題・気づき
- 順序が保存されない原因は楽観的更新のロールバック漏れでした。同じパターンが他の API 呼び出しにもないか確認が必要です（要確認）
- #131 は refresh の競合に注意が必要とコメントしました

## 明日やること
- PR #133 のレビュー対応
- 他の楽観的更新箇所の点検（要確認）`;
fs.writeFileSync(path.join(dir, `${date}.ai.json`), JSON.stringify({ blocks, blocksAt: at('18:00'), report, reportAt: at('18:01'), model: 'claude-opus-5-5' }, null, 2));
console.log(`demo day ${date} written to ${dir}`);
