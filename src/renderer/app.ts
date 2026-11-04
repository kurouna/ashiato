import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { AshiatoApi } from '../preload';
import { Category, DayData, JournalEvent, MODELS, PublicSettings, StreamEvent, WorkBlock, dayKey, hhmm, startOfDay } from '../shared/types';

const api = (window as unknown as { ashiato: AshiatoApi }).ashiato;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let date = dayKey(Date.now());
let day: DayData | null = null;
let settings: PublicSettings;

const CAT_LABEL: Record<Category, string> = {
  coding: '実装',
  review: 'レビュー',
  debugging: 'デバッグ',
  research: '調査',
  writing: '執筆',
  meeting: '会議',
  communication: '連絡',
  design: '設計',
  admin: '事務',
  break: '休憩',
  other: 'その他',
};
const CAT_COLOR: Record<Category, string> = {
  coding: '#7aa2f7',
  review: '#bb9af7',
  debugging: '#f7768e',
  research: '#2ac3de',
  writing: '#9ece6a',
  meeting: '#e0af68',
  communication: '#ff9e64',
  design: '#73daca',
  admin: '#a9b1d6',
  break: '#4b5263',
  other: '#787c99',
};

// ---------- streaming plumbing ----------
const streams = new Map<string, (e: StreamEvent) => void>();
api.onStream((e) => streams.get(e.reqId)?.(e));
const newReq = () => Math.random().toString(36).slice(2);

function md(text: string) {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

// ---------- helpers ----------
function fmtDur(ms: number) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}時間${String(m % 60).padStart(2, '0')}分` : `${m}分`;
}
function hashHue(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
const appColor = (app: string) => (app === '(非公開)' ? '#3a3f4b' : `hsl(${hashHue(app.toLowerCase())} 62% 62%)`);
function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function toMs(hm: string) {
  const [h, m] = hm.split(':').map(Number);
  return startOfDay(date) + (h * 60 + m) * 60000;
}

function eventsWithLive(): JournalEvent[] {
  if (!day) return [];
  const evs = [...day.events];
  const live = day.live;
  if (live) {
    const now = Date.now();
    evs.push(live.kind === 'idle' ? { t: 'idle', start: live.start, end: now } : { t: 'window', start: live.start, end: now, app: live.app, title: live.title });
  }
  return evs;
}

// ---------- load & render ----------
async function load() {
  day = await api.getDay(date);
  ($('datePick') as HTMLInputElement).value = date;
  $('nextDay').toggleAttribute('disabled', date >= dayKey(Date.now()));
  render();
}

function render() {
  const evs = eventsWithLive();
  const hasData = evs.length > 0;
  $('empty').classList.toggle('hidden', hasData);
  $('timeline').classList.toggle('hidden', !hasData);
  renderTimeline(evs);
  renderStats(evs);
  renderBlocks(day?.ai.blocks);
  if (!reportBusy) renderReport(day?.ai.report);
}

function renderTimeline(evs: JournalEvent[]) {
  const el = $('timeline');
  if (!evs.length) return (el.innerHTML = '');
  const times = evs.flatMap((e) => ('ts' in e ? [e.ts] : [e.start, e.end]));
  const dayStart = startOfDay(date);
  const H = 3600_000;
  let t0 = Math.floor((Math.min(...times) - dayStart) / H) * H + dayStart;
  let t1 = Math.ceil((Math.max(...times) - dayStart) / H) * H + dayStart;
  if (t1 - t0 < 4 * H) t1 = t0 + 4 * H;
  t0 = Math.max(t0, dayStart);
  t1 = Math.min(t1, dayStart + 24 * H);

  const W = Math.max(600, el.clientWidth);
  const left = 78;
  const right = 20;
  const x = (t: number) => left + ((t - t0) / (t1 - t0)) * (W - left - right);
  const blocks = day?.ai.blocks ?? [];
  const lanes = [...(blocks.length ? ['作業'] : []), 'アプリ', 'ファイル', 'git・メモ'];
  const laneH = 30;
  const top = 22;
  const Ht = top + lanes.length * laneH + 6;
  const laneY = (name: string) => top + lanes.indexOf(name) * laneH;

  const parts: string[] = [];
  for (let t = t0; t <= t1; t += H) {
    parts.push(`<line x1="${x(t)}" x2="${x(t)}" y1="${top - 4}" y2="${Ht}" class="grid"/>`);
    parts.push(`<text x="${x(t)}" y="12" class="axis">${new Date(t).getHours()}:00</text>`);
  }
  lanes.forEach((name) => parts.push(`<text x="0" y="${laneY(name) + 19}" class="lane">${name}</text>`));

  for (const b of blocks) {
    const s = toMs(b.start);
    const e = Math.max(toMs(b.end), s + 60000);
    parts.push(
      `<rect x="${x(s)}" y="${laneY('作業') + 3}" width="${Math.max(2, x(e) - x(s))}" height="${laneH - 8}" rx="4" fill="${CAT_COLOR[b.category] ?? '#888'}" data-tip="${esc(`${b.start}–${b.end} ${b.title}\n${CAT_LABEL[b.category]}${b.project ? ' · ' + b.project : ''}\n${b.summary}`)}"/>`,
    );
  }
  for (const e of evs) {
    if (e.t === 'window' || e.t === 'idle') {
      const fill = e.t === 'idle' ? 'url(#idlePat)' : appColor(e.app);
      const tip = e.t === 'idle' ? `${hhmm(e.start)}–${hhmm(e.end)} 離席` : `${hhmm(e.start)}–${hhmm(e.end)} (${fmtDur(e.end - e.start)})\n${e.app}\n${e.title}`;
      parts.push(`<rect x="${x(e.start)}" y="${laneY('アプリ') + 3}" width="${Math.max(1, x(e.end) - x(e.start))}" height="${laneH - 8}" fill="${fill}" data-tip="${esc(tip)}"/>`);
    } else if (e.t === 'file') {
      parts.push(`<rect x="${x(e.ts) - 1}" y="${laneY('ファイル') + 5}" width="2" height="${laneH - 12}" class="tick" data-tip="${esc(`${hhmm(e.ts)} ${e.path}`)}"/>`);
    } else if (e.t === 'commit') {
      const cx = x(e.ts);
      const cy = laneY('git・メモ') + laneH / 2 - 1;
      parts.push(`<path d="M${cx} ${cy - 7}L${cx + 7} ${cy}L${cx} ${cy + 7}L${cx - 7} ${cy}Z" class="commit" data-tip="${esc(`${hhmm(e.ts)} commit <${e.repo}>\n${e.subject}`)}"/>`);
    } else if (e.t === 'memo') {
      parts.push(`<circle cx="${x(e.ts)}" cy="${laneY('git・メモ') + laneH / 2 - 1}" r="6" class="memo-dot" data-tip="${esc(`${hhmm(e.ts)} メモ\n${e.text}`)}"/>`);
    }
  }
  if (date === dayKey(Date.now())) {
    const nx = x(Date.now());
    parts.push(`<line x1="${nx}" x2="${nx}" y1="${top - 6}" y2="${Ht}" class="now"/>`);
  }
  el.innerHTML = `<svg width="${W}" height="${Ht}" viewBox="0 0 ${W} ${Ht}">
    <defs><pattern id="idlePat" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#20232b"/><line x1="0" y1="0" x2="0" y2="6" stroke="#3a3f4b" stroke-width="3"/></pattern></defs>
    ${parts.join('')}</svg>`;

  const legend = blocks.length ? [...new Set(blocks.map((b) => b.category))] : [];
  $('legend').innerHTML = legend.map((c) => `<span><i style="background:${CAT_COLOR[c]}"></i>${CAT_LABEL[c]}</span>`).join('');
}

function renderStats(evs: JournalEvent[]) {
  const byApp = new Map<string, number>();
  let active = 0;
  const files = new Set<string>();
  const commits: Extract<JournalEvent, { t: 'commit' }>[] = [];
  const memos: Extract<JournalEvent, { t: 'memo' }>[] = [];
  for (const e of evs) {
    if (e.t === 'window') {
      active += e.end - e.start;
      byApp.set(e.app || '?', (byApp.get(e.app || '?') ?? 0) + e.end - e.start);
    } else if (e.t === 'file') files.add(e.root + e.path);
    else if (e.t === 'commit') commits.push(e);
    else if (e.t === 'memo') memos.push(e);
  }
  $('kpiActive').textContent = fmtDur(active);
  $('kpiFiles').textContent = String(files.size);
  $('kpiCommits').textContent = String(commits.length);
  const top = [...byApp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7);
  const max = top[0]?.[1] ?? 1;
  $('appBars').innerHTML = top
    .map(([app, ms]) => `<li><span class="name">${esc(app)}</span><span class="bar"><i style="width:${(ms / max) * 100}%;background:${appColor(app)}"></i></span><span class="val">${fmtDur(ms)}</span></li>`)
    .join('') || '<li class="muted">—</li>';
  $('commitList').innerHTML = commits.map((c) => `<li><time>${hhmm(c.ts)}</time> <b>${esc(c.repo)}</b> ${esc(c.subject)}</li>`).join('') || '<li class="muted">—</li>';
  $('memoList').innerHTML = memos.map((m) => `<li><time>${hhmm(m.ts)}</time> ${esc(m.text)}</li>`).join('') || '<li class="muted">—</li>';
}

function renderBlocks(blocks?: WorkBlock[]) {
  const el = $('blockList');
  if (!blocks?.length) {
    el.innerHTML = `<p class="muted">Claude がタイムラインを読み、細かなアプリの行き来を「意味のある作業のまとまり」に整理します。</p>`;
    return;
  }
  el.innerHTML = blocks
    .map(
      (b) => `<div class="block" style="--c:${CAT_COLOR[b.category]}">
        <div class="bt"><time>${b.start}–${b.end}</time><span class="cat">${CAT_LABEL[b.category]}</span>${b.project ? `<span class="proj">${esc(b.project)}</span>` : ''}</div>
        <div class="bh">${esc(b.title)}</div>
        <div class="bs">${esc(b.summary)}</div>
      </div>`,
    )
    .join('');
  if (day?.ai.blocksAt) $('segmentStatus').textContent = `${new Date(day.ai.blocksAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} に整理（${day.ai.model ?? ''}）`;
}

function renderReport(report?: string) {
  $('reportBody').innerHTML = report ? md(report) : `<p class="muted">記録と作業ブロックから、Claude が日報の下書きを書きます。テンプレートは ⚙ で変更できます。</p>`;
  $('copyReport').toggleAttribute('disabled', !report);
}

// ---------- tooltip ----------
const tip = $('tooltip');
$('timeline').addEventListener('mousemove', (e) => {
  const t = (e.target as Element).closest('[data-tip]');
  if (!t) return tip.classList.add('hidden');
  tip.textContent = t.getAttribute('data-tip');
  tip.classList.remove('hidden');
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(e.clientX + 14, innerWidth - r.width - 8)}px`;
  tip.style.top = `${Math.min(e.clientY + 14, innerHeight - r.height - 8)}px`;
});
$('timeline').addEventListener('mouseleave', () => tip.classList.add('hidden'));

// ---------- AI: blocks ----------
$('segmentBtn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('segmentBtn');
  btn.disabled = true;
  $('segmentStatus').innerHTML = '<span class="spin"></span> Claude が整理しています…';
  const res = await api.segment(date);
  btn.disabled = false;
  if (!res.ok) return void ($('segmentStatus').innerHTML = `<span class="err">${esc(res.error)}</span>`);
  if (day) day.ai = res.ai;
  render();
});

// ---------- AI: report ----------
let reportBusy = false;
$('reportBtn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('reportBtn');
  btn.disabled = true;
  reportBusy = true;
  const reqId = newReq();
  let text = '';
  let thinking = '';
  const box = $('thinkingBox') as HTMLDetailsElement;
  box.classList.add('hidden');
  box.open = true;
  $('thinkingText').textContent = '';
  $('reportBody').innerHTML = '';
  $('reportStatus').innerHTML = '<span class="spin"></span> 考えています…';
  streams.set(reqId, (e) => {
    if (e.kind === 'thinking') {
      thinking += e.data;
      box.classList.remove('hidden');
      $('thinkingText').textContent = thinking;
    } else if (e.kind === 'text') {
      if (!text) {
        box.open = false;
        $('reportStatus').innerHTML = '<span class="spin"></span> 書いています…';
      }
      text += e.data;
      $('reportBody').innerHTML = md(text);
    }
  });
  const res = await api.report(date, reqId);
  streams.delete(reqId);
  reportBusy = false;
  btn.disabled = false;
  if (!res.ok) return void ($('reportStatus').innerHTML = `<span class="err">${esc(res.error)}</span>`);
  $('reportStatus').textContent = '保存しました';
  if (day) day.ai = res.ai;
  renderReport(res.ai.report);
});
$('copyReport').addEventListener('click', async () => {
  if (!day?.ai.report) return;
  await navigator.clipboard.writeText(day.ai.report);
  $('reportStatus').textContent = 'コピーしました';
});

// ---------- AI: ask ----------
const chatLog = $('chatLog');
const askInput = $<HTMLTextAreaElement>('askInput');
let asking = false;

function bubble(cls: string, html: string) {
  chatLog.querySelector('.suggest')?.remove();
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.innerHTML = html;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

async function ask(q: string) {
  if (asking || !q.trim()) return;
  asking = true;
  $<HTMLButtonElement>('askBtn').disabled = true;
  bubble('user', esc(q));
  const out = bubble('bot', '<div class="tools"></div><details class="thinking hidden"><summary>思考の要約</summary><div class="th"></div></details><div class="md body"><span class="spin"></span></div>');
  const tools = out.querySelector('.tools')!;
  const th = out.querySelector('details')!;
  const body = out.querySelector('.body')!;
  let text = '';
  let thinking = '';
  const reqId = newReq();
  streams.set(reqId, (e) => {
    if (e.kind === 'text') {
      text += e.data;
      body.innerHTML = md(text);
    } else if (e.kind === 'thinking') {
      thinking += e.data;
      th.classList.remove('hidden');
      th.querySelector('.th')!.textContent = thinking;
    } else if (e.kind === 'tool') {
      const [name, ...rest] = e.data.split(' ');
      const chip = document.createElement('span');
      chip.className = 'toolchip';
      chip.textContent = `🔍 ${name} ${rest.join(' ')}`;
      tools.appendChild(chip);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  });
  const res = await api.ask(q, reqId);
  streams.delete(reqId);
  if (!res.ok) body.innerHTML = `<span class="err">${esc(res.error)}</span>`;
  else body.innerHTML = md(res.answer || text);
  asking = false;
  $<HTMLButtonElement>('askBtn').disabled = false;
  chatLog.scrollTop = chatLog.scrollHeight;
}

$('askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = askInput.value;
  askInput.value = '';
  ask(q);
});
askInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('askForm').dispatchEvent(new Event('submit', { cancelable: true }));
  }
});
chatLog.addEventListener('click', (e) => {
  const chip = (e.target as Element).closest('.chip');
  if (chip) ask(chip.textContent ?? '');
});
$('newChat').addEventListener('click', async () => {
  await api.resetChat();
  chatLog.innerHTML = '<p class="muted">新しい会話を始めました。</p>';
});

// ---------- tabs ----------
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll<HTMLElement>('.pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== t.dataset.tab));
  }),
);

// ---------- preview ----------
$('previewBtn').addEventListener('click', async () => {
  $('previewText').textContent = (await api.preview(date)) || '（この日の記録はありません）';
  ($('previewDlg') as HTMLDialogElement).showModal();
});

// ---------- date nav ----------
function shift(days: number) {
  const d = new Date(startOfDay(date));
  d.setDate(d.getDate() + days);
  date = dayKey(d.getTime());
  load();
}
$('prevDay').addEventListener('click', () => shift(-1));
$('nextDay').addEventListener('click', () => shift(1));
$('today').addEventListener('click', () => {
  date = dayKey(Date.now());
  load();
});
$('datePick').addEventListener('change', (e) => {
  const v = (e.target as HTMLInputElement).value;
  if (v) {
    date = v;
    load();
  }
});

// ---------- memo ----------
$('memoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('memoInput');
  if (!input.value.trim()) return;
  await api.addMemo(input.value);
  input.value = '';
  input.placeholder = '記録しました ✓';
  setTimeout(() => (input.placeholder = 'ひとことメモ（Ctrl+Alt+J でどこからでも）'), 1500);
});

// ---------- recording toggle ----------
function renderRec() {
  $('recToggle').classList.toggle('paused', settings.paused);
  $('recLabel').textContent = settings.paused ? '一時停止中' : '記録中';
}
$('recToggle').addEventListener('click', async () => {
  settings = await api.setSettings({ paused: !settings.paused });
  renderRec();
});

// ---------- settings ----------
const dlg = $('settingsDlg') as HTMLDialogElement;
function fillSettings() {
  $('keyState').textContent =
    settings.apiKeySource === 'saved' ? '✓ 保存済み（OS の暗号化ストレージ）' : settings.apiKeySource === 'env' ? '✓ 環境変数 ANTHROPIC_API_KEY を使用中' : '未設定 — AI 機能を使うには必要です';
  $<HTMLSelectElement>('model').innerHTML = MODELS.map((m) => `<option value="${m.id}" ${m.id === settings.model ? 'selected' : ''}>${m.label}</option>`).join('');
  $('folderList').innerHTML =
    settings.watchFolders.map((f, i) => `<li><span>${esc(f)}</span><button type="button" class="icon" data-rm="${i}">×</button></li>`).join('') || '<li class="muted">未登録</li>';
  $<HTMLTextAreaElement>('exclude').value = settings.excludeKeywords.join('\n');
  $<HTMLInputElement>('idleMin').value = String(settings.idleMinutes);
  $<HTMLInputElement>('poll').value = String(settings.pollSeconds);
  $<HTMLTextAreaElement>('template').value = settings.reportTemplate;
  $<HTMLInputElement>('openAtLogin').checked = settings.openAtLogin;
}
$('openSettings').addEventListener('click', () => {
  fillSettings();
  dlg.showModal();
});
$('saveKey').addEventListener('click', async () => {
  const v = $<HTMLInputElement>('apiKey').value.trim();
  if (!v) return;
  settings = await api.setApiKey(v);
  $<HTMLInputElement>('apiKey').value = '';
  fillSettings();
});
$('clearKey').addEventListener('click', async () => {
  settings = await api.setApiKey(null);
  fillSettings();
});
$('addFolder').addEventListener('click', async () => {
  settings = await api.pickFolder();
  fillSettings();
});
$('folderList').addEventListener('click', async (e) => {
  const rm = (e.target as HTMLElement).dataset.rm;
  if (rm === undefined) return;
  settings = await api.setSettings({ watchFolders: settings.watchFolders.filter((_, i) => i !== Number(rm)) });
  fillSettings();
});
$('openData').addEventListener('click', (e) => {
  e.preventDefault();
  api.openData();
});
$('saveSettings').addEventListener('click', async () => {
  settings = await api.setSettings({
    model: $<HTMLSelectElement>('model').value,
    excludeKeywords: $<HTMLTextAreaElement>('exclude').value.split('\n').map((s) => s.trim()).filter(Boolean),
    idleMinutes: Math.max(1, Number($<HTMLInputElement>('idleMin').value) || 5),
    pollSeconds: Math.max(1, Number($<HTMLInputElement>('poll').value) || 5),
    reportTemplate: $<HTMLTextAreaElement>('template').value,
    openAtLogin: $<HTMLInputElement>('openAtLogin').checked,
  });
  renderRec();
});

// ---------- live updates ----------
let reloadTimer: number | undefined;
api.onJournalChanged((d) => {
  if (d !== date) return;
  clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(load, 300);
});
api.onSettingsChanged((s) => {
  settings = s;
  renderRec();
});
setInterval(() => date === dayKey(Date.now()) && render(), 30_000);
window.addEventListener('resize', () => render());

(async () => {
  settings = await api.getSettings();
  renderRec();
  await load();
  if (!settings.hasApiKey && !settings.watchFolders.length) {
    fillSettings();
    dlg.showModal();
  }
})();
