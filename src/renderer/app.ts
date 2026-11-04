import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { AshiatoApi } from '../preload';
import { Category, DayData, JournalEvent, MODELS, PublicSettings, Status, StreamEvent, WorkBlock, dayKey, hhmm, startOfDay } from '../shared/types';

const api = (window as unknown as { ashiato: AshiatoApi }).ashiato;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let date = dayKey(Date.now());
let day: DayData | null = null;
let settings: PublicSettings;
let status: Status | null = null;
let timelineEvents: JournalEvent[] = [];

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
const newReq = () => crypto.randomUUID();

function md(text: string) {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
    FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'style', 'iframe', 'img'],
    FORBID_ATTR: ['style', 'target'],
  });
}
// links in AI output never navigate the window; main asks before opening them in the browser
document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest('a[href]') as HTMLAnchorElement | null;
  if (!a || a.id === 'openData') return;
  e.preventDefault();
  if (/^https?:/i.test(a.href)) api.openLink(a.href);
});

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
const appColor = (app: string) => (app === '(非公開)' ? 'var(--private)' : `hsl(${hashHue(app.toLowerCase())} 62% 60%)`);
function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function toMs(hm: string) {
  const [h, m] = hm.split(':').map(Number);
  return startOfDay(date) + (h * 60 + m) * 60000;
}
function setStatus(id: string, text: string, kind: 'muted' | 'busy' | 'err' = 'muted') {
  $(id).innerHTML = kind === 'busy' ? `<span class="spin"></span> ${esc(text)}` : kind === 'err' ? `<span class="err">${esc(text)}</span>` : esc(text);
}
function plainText(markdown: string) {
  const div = document.createElement('div');
  div.innerHTML = md(markdown);
  div.querySelectorAll('li').forEach((li) => li.prepend('・'));
  div.querySelectorAll('h1,h2,h3,h4').forEach((h) => h.prepend('■ '));
  return div.innerText.replace(/\n{3,}/g, '\n\n').trim();
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
  const asked = date;
  const d = await api.getDay(asked);
  if (asked !== date) return; // user moved on while loading
  day = d;
  ($('datePick') as HTMLInputElement).value = date;
  $('nextDay').toggleAttribute('disabled', date >= dayKey(Date.now()));
  render();
}

function render() {
  const evs = eventsWithLive();
  const hasData = evs.length > 0;
  $('empty').classList.toggle('hidden', hasData);
  $('timeline').classList.toggle('hidden', !hasData);
  $('deleteDay').classList.toggle('hidden', !day?.events.length);
  renderTimeline(evs);
  renderStats(evs);
  renderBlocks(day?.ai.blocks);
  if (!reportBusy && !editing) renderReport(day?.ai.report);
}

function renderTimeline(evs: JournalEvent[]) {
  const el = $('timeline');
  timelineEvents = evs;
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
  const x = (t: number) => left + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * (W - left - right);
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
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    parts.push(
      `<rect x="${x(s)}" y="${laneY('作業') + 3}" width="${Math.max(2, x(e) - x(s))}" height="${laneH - 8}" rx="4" fill="${CAT_COLOR[b.category] ?? '#888'}" data-tip="${esc(`${b.start}–${b.end} ${b.title}\n${CAT_LABEL[b.category] ?? ''}${b.project ? ' · ' + b.project : ''}\n${b.summary}`)}"/>`,
    );
  }
  evs.forEach((e, i) => {
    const live = i >= (day?.events.length ?? 0) ? '' : ` data-idx="${i}"`;
    if (e.t === 'window' || e.t === 'idle') {
      const fill = e.t === 'idle' ? 'url(#idlePat)' : appColor(e.app);
      const tip = e.t === 'idle' ? `${hhmm(e.start)}–${hhmm(e.end)} 離席` : `${hhmm(e.start)}–${hhmm(e.end)} (${fmtDur(e.end - e.start)})\n${e.app}\n${e.title}`;
      parts.push(`<rect x="${x(e.start)}" y="${laneY('アプリ') + 3}" width="${Math.max(1, x(e.end) - x(e.start))}" height="${laneH - 8}" fill="${fill}"${live} data-tip="${esc(tip)}"/>`);
    } else if (e.t === 'file') {
      parts.push(`<rect x="${x(e.ts) - 1}" y="${laneY('ファイル') + 5}" width="2" height="${laneH - 12}" class="tick"${live} data-tip="${esc(`${hhmm(e.ts)} ${e.path}`)}"/>`);
    } else if (e.t === 'commit') {
      const cx = x(e.ts);
      const cy = laneY('git・メモ') + laneH / 2 - 1;
      parts.push(`<path d="M${cx} ${cy - 7}L${cx + 7} ${cy}L${cx} ${cy + 7}L${cx - 7} ${cy}Z" class="commit"${live} data-tip="${esc(`${hhmm(e.ts)} commit 「${e.repo}」\n${e.subject}`)}"/>`);
    } else if (e.t === 'memo') {
      parts.push(`<circle cx="${x(e.ts)}" cy="${laneY('git・メモ') + laneH / 2 - 1}" r="6" class="memo-dot"${live} data-tip="${esc(`${hhmm(e.ts)} メモ\n${e.text}`)}"/>`);
    }
  });
  if (date === dayKey(Date.now())) {
    const nx = x(Date.now());
    parts.push(`<line x1="${nx}" x2="${nx}" y1="${top - 6}" y2="${Ht}" class="now"/>`);
  }
  el.innerHTML = `<svg width="${W}" height="${Ht}" viewBox="0 0 ${W} ${Ht}" role="img" aria-label="${date} のタイムライン">
    <defs><pattern id="idlePat" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="idle-bg"/><line x1="0" y1="0" x2="0" y2="6" class="idle-line" stroke-width="3"/></pattern></defs>
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
  $('appBars').innerHTML =
    top.map(([app, ms]) => `<li><span class="name" title="${esc(app)}">${esc(app)}</span><span class="bar"><i style="width:${(ms / max) * 100}%;background:${appColor(app)}"></i></span><span class="val">${fmtDur(ms)}</span></li>`).join('') ||
    '<li class="muted">—</li>';
  $('commitList').innerHTML = commits.map((c) => `<li><time>${hhmm(c.ts)}</time> <b>${esc(c.repo)}</b> ${esc(c.subject)}</li>`).join('') || '<li class="muted">—</li>';
  $('memoList').innerHTML = memos.map((m) => `<li><time>${hhmm(m.ts)}</time> ${esc(m.text)}</li>`).join('') || '<li class="muted">—</li>';
}

function renderBlocks(blocks?: WorkBlock[]) {
  const el = $('blockList');
  if (!segmentBusy) setStatus('segmentStatus', day?.ai.blocksAt ? `${new Date(day.ai.blocksAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} に整理（${day.ai.model ?? ''}）` : '');
  if (!blocks?.length) {
    el.innerHTML = `<p class="muted">AI がタイムラインを読み、細かなアプリの行き来を「意味のある作業のまとまり」に整理します。</p>`;
    return;
  }
  el.innerHTML = blocks
    .map(
      (b) => `<div class="block" style="--c:${CAT_COLOR[b.category] ?? '#888'}">
        <div class="bt"><time>${esc(b.start)}–${esc(b.end)}</time><span class="cat">${CAT_LABEL[b.category] ?? ''}</span>${b.project ? `<span class="proj">${esc(b.project)}</span>` : ''}</div>
        <div class="bh">${esc(b.title)}</div>
        <div class="bs">${esc(b.summary)}</div>
      </div>`,
    )
    .join('');
}

function renderReport(report?: string) {
  $('reportBody').innerHTML = report ? md(report) : `<p class="muted">記録と作業ブロックから、AI が日報の下書きを書きます。生成後は「編集」で直せます。テンプレートは ⚙ で変更できます。</p>`;
  for (const id of ['copyReport', 'copyPlain', 'editReport']) $(id).toggleAttribute('disabled', !report);
  if (!reportBusy) setStatus('reportStatus', day?.ai.reportAt ? `${new Date(day.ai.reportAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 保存` : '');
}

// ---------- tooltip & delete ----------
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
$('timeline').addEventListener('contextmenu', async (e) => {
  const t = (e.target as Element).closest('[data-idx]');
  if (!t) return;
  e.preventDefault();
  const ev = timelineEvents[Number(t.getAttribute('data-idx'))];
  if (!ev || !confirm(`この記録を削除しますか？\n\n${t.getAttribute('data-tip')}`)) return;
  await api.deleteEvent(date, ev);
  load();
});
$('deleteDay').addEventListener('click', async () => {
  if (await api.deleteDay(date)) load();
});

// ---------- AI: blocks ----------
let segmentBusy = false;
$('segmentBtn').addEventListener('click', async () => {
  const forDate = date;
  const btn = $<HTMLButtonElement>('segmentBtn');
  btn.disabled = true;
  segmentBusy = true;
  setStatus('segmentStatus', 'AI が整理しています…', 'busy');
  const res = await api.segment(forDate);
  segmentBusy = false;
  btn.disabled = false;
  if (forDate !== date) return;
  if (!res.ok) return setStatus('segmentStatus', res.error, 'err');
  if (day) day.ai = res.ai;
  render();
});

// ---------- AI: report ----------
let reportBusy = false;
let editing = false;
let reportReq: string | null = null;

$('reportBtn').addEventListener('click', async () => {
  if (day?.ai.report && !confirm('保存済みの日報を新しい下書きで置き換えます。よろしいですか？')) return;
  const forDate = date;
  const btn = $<HTMLButtonElement>('reportBtn');
  btn.disabled = true;
  reportBusy = true;
  const reqId = (reportReq = newReq());
  $('cancelReport').classList.remove('hidden');
  let text = '';
  let thinking = '';
  const box = $('thinkingBox') as HTMLDetailsElement;
  box.classList.add('hidden');
  box.open = true;
  $('thinkingText').textContent = '';
  $('reportBody').innerHTML = '';
  setStatus('reportStatus', '考えています…', 'busy');
  streams.set(reqId, (e) => {
    if (forDate !== date) return;
    if (e.kind === 'thinking') {
      thinking += e.data;
      box.classList.remove('hidden');
      $('thinkingText').textContent = thinking;
    } else if (e.kind === 'text') {
      if (!text) {
        box.open = false;
        setStatus('reportStatus', '書いています…', 'busy');
      }
      text += e.data;
      $('reportBody').innerHTML = md(text);
    }
  });
  const res = await api.report(forDate, reqId);
  streams.delete(reqId);
  reportBusy = false;
  reportReq = null;
  btn.disabled = false;
  $('cancelReport').classList.add('hidden');
  if (forDate !== date) return;
  if (!res.ok) {
    renderReport(day?.ai.report);
    return setStatus('reportStatus', res.error, 'err');
  }
  if (day) day.ai = res.ai;
  renderReport(res.ai.report);
});
$('cancelReport').addEventListener('click', () => reportReq && api.cancel(reportReq));

function setEditing(on: boolean) {
  editing = on;
  $('reportEditor').classList.toggle('hidden', !on);
  $('reportBody').classList.toggle('hidden', on);
  if (on) $<HTMLTextAreaElement>('reportText').value = day?.ai.report ?? '';
}
$('editReport').addEventListener('click', () => setEditing(true));
$('cancelEdit').addEventListener('click', () => setEditing(false));
$('saveReport').addEventListener('click', async () => {
  const report = $<HTMLTextAreaElement>('reportText').value;
  const saved = await api.saveAi(date, { report });
  if (day) day.ai = saved;
  setEditing(false);
  renderReport(saved.report);
  setStatus('reportStatus', '保存しました');
});
$('copyReport').addEventListener('click', async () => {
  if (!day?.ai.report) return;
  await api.copy(day.ai.report);
  setStatus('reportStatus', 'Markdown をコピーしました');
});
$('copyPlain').addEventListener('click', async () => {
  if (!day?.ai.report) return;
  await api.copy(plainText(day.ai.report));
  setStatus('reportStatus', 'テキストをコピーしました');
});

// ---------- AI: ask ----------
const chatLog = $('chatLog');
const askInput = $<HTMLTextAreaElement>('askInput');
let askReq: string | null = null;

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
  if (askReq || !q.trim()) return;
  const reqId = (askReq = newReq());
  $<HTMLButtonElement>('askBtn').disabled = true;
  $('cancelAsk').classList.remove('hidden');
  bubble('user', esc(q));
  const out = bubble('bot', '<div class="tools"></div><details class="thinking hidden"><summary>思考の要約</summary><div class="th"></div></details><div class="md body"><span class="spin"></span></div>');
  const tools = out.querySelector('.tools')!;
  const th = out.querySelector('details')!;
  const body = out.querySelector('.body')!;
  let text = '';
  let thinking = '';
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
      chip.title = '記録を参照しました（この結果が AI に送られます）';
      chip.textContent = `🔍 ${name} ${rest.join(' ')}`;
      tools.appendChild(chip);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  });
  const res = await api.ask(q, reqId);
  streams.delete(reqId);
  body.innerHTML = res.ok ? md(res.answer || text) : `<span class="err">${esc(res.error)}</span>`;
  askReq = null;
  $<HTMLButtonElement>('askBtn').disabled = false;
  $('cancelAsk').classList.add('hidden');
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
$('cancelAsk').addEventListener('click', () => askReq && api.cancel(askReq));
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
  const p = await api.preview(date);
  $('previewText').textContent = p.text || '（この日の記録はありません）';
  $('previewDest').textContent = `送信先: ${p.destination}`;
  $('previewSize').textContent = `約 ${p.text.length.toLocaleString()} 文字（目安 ${Math.ceil(p.text.length / 1.5).toLocaleString()} トークン）。`;
  ($('previewDlg') as HTMLDialogElement).showModal();
});
$('closePreview').addEventListener('click', () => ($('previewDlg') as HTMLDialogElement).close());

// ---------- date nav ----------
function goTo(d: string) {
  date = d;
  if (editing) setEditing(false);
  $('thinkingBox').classList.add('hidden');
  load();
}
function shift(days: number) {
  const d = new Date(startOfDay(date));
  d.setDate(d.getDate() + days);
  goTo(dayKey(d.getTime()));
}
$('prevDay').addEventListener('click', () => shift(-1));
$('nextDay').addEventListener('click', () => shift(1));
$('today').addEventListener('click', () => goTo(dayKey(Date.now())));
$('datePick').addEventListener('change', (e) => {
  const v = (e.target as HTMLInputElement).value;
  if (v) goTo(v);
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

// ---------- recording state & pause ----------
function renderRec() {
  const paused = settings.paused;
  const until = paused && settings.pausedUntil ? `（${new Date(settings.pausedUntil).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}まで）` : '';
  const broken = settings.onboarded && !paused && status && !status.probeOk;
  $('recToggle').classList.toggle('paused', paused || !settings.onboarded);
  $('recToggle').classList.toggle('broken', !!broken);
  $('recLabel').textContent = !settings.onboarded ? '未開始' : paused ? `一時停止中${until}` : broken ? '記録できていません' : '記録中';
  $('destLabel').textContent = settings.provider === 'local' ? '🔒 ローカル LLM' : '☁ Claude API';
  $('destLabel').title = status?.destination ?? '';

  const warn: string[] = [];
  if (!settings.onboarded) warn.push('記録はまだ開始していません。');
  if (broken && status?.probeReason) warn.push(status.probeReason);
  if (status && !status.shortcutOk) warn.push('Ctrl+Alt+J は他のアプリが使用中のため、クイックメモのショートカットが使えません。');
  if (status?.watchErrors.length) warn.push(`見つからないフォルダがあります: ${status.watchErrors.join(', ')}`);
  if (settings.secretUnreadable) warn.push('保存済みのキーを復号できませんでした（別の PC やユーザーから移した可能性）。⚙ から再入力してください。');
  $('banner').classList.toggle('hidden', !warn.length);
  $('banner').innerHTML = warn.map((w) => `<div>⚠ ${esc(w)}</div>`).join('') + (!settings.onboarded ? ' <button id="bannerStart" class="ghost small">開始する</button>' : '');
}
$('banner').addEventListener('click', (e) => {
  if ((e.target as HTMLElement).id === 'bannerStart') obDlg.showModal();
});
const pauseMenu = $('pauseMenu');
$('recToggle').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!settings.onboarded) return obDlg.showModal();
  if (settings.paused) {
    settings = await api.pause(null);
    return renderRec();
  }
  pauseMenu.classList.toggle('hidden');
});
pauseMenu.addEventListener('click', async (e) => {
  const v = (e.target as HTMLElement).dataset.pause;
  if (!v) return;
  pauseMenu.classList.add('hidden');
  settings = v === 'forever' ? await api.setSettings({ paused: true, pausedUntil: null }) : await api.pause(v === 'today' ? 'today' : Number(v));
  renderRec();
});
document.addEventListener('click', () => pauseMenu.classList.add('hidden'));

// ---------- onboarding ----------
const obDlg = $('onboardDlg') as HTMLDialogElement;
$('obStart').addEventListener('click', async () => {
  settings = await api.setSettings({ provider: $<HTMLSelectElement>('obProvider').value as 'claude' | 'local' });
  api.finishOnboarding();
  obDlg.close();
  openSettings();
});
$('obLater').addEventListener('click', () => obDlg.close());

// ---------- settings ----------
const dlg = $('settingsDlg') as HTMLDialogElement;
const radios = () => [...document.querySelectorAll<HTMLInputElement>('input[name=provider]')];
function syncProviderBoxes() {
  const local = radios().find((r) => r.checked)?.value === 'local';
  $('claudeBox').classList.toggle('hidden', local);
  $('localBox').classList.toggle('hidden', !local);
}
radios().forEach((r) => r.addEventListener('change', syncProviderBoxes));

function fillSettings() {
  radios().forEach((r) => (r.checked = r.value === settings.provider));
  syncProviderBoxes();
  $('keyState').textContent = settings.secretUnreadable
    ? '⚠ 保存済みのキーを復号できません。再入力してください'
    : settings.apiKeySource === 'saved'
      ? '✓ 保存済み（OS の暗号化ストレージ）'
      : settings.apiKeySource === 'env'
        ? '✓ 環境変数 ANTHROPIC_API_KEY を使用中'
        : settings.encryptionAvailable
          ? '未設定 — Claude を使うには必要です'
          : '⚠ OS の暗号化ストレージが使えないため保存できません。環境変数 ANTHROPIC_API_KEY を使ってください';
  const models: { id: string; label: string }[] = [...MODELS];
  if (!models.some((m) => m.id === settings.model)) models.push({ id: settings.model, label: settings.model });
  $<HTMLSelectElement>('model').innerHTML = models.map((m) => `<option value="${esc(m.id)}" ${m.id === settings.model ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
  $<HTMLInputElement>('localUrl').value = settings.localBaseUrl;
  $<HTMLInputElement>('localModel').value = settings.localModel;
  $<HTMLInputElement>('localKey').placeholder = settings.hasLocalKey ? '保存済み' : '不要なら空のまま';
  $<HTMLInputElement>('redact').checked = settings.redact;
  $('folderList').innerHTML =
    settings.watchFolders.map((f, i) => `<li><span>${esc(f)}</span><button type="button" class="icon" data-rm="${i}" aria-label="削除">×</button></li>`).join('') || '<li class="muted">未登録</li>';
  $<HTMLTextAreaElement>('exclude').value = settings.excludeKeywords.join('\n');
  $<HTMLTextAreaElement>('excludeApps').value = settings.excludeApps.join('\n');
  $<HTMLInputElement>('idleMin').value = String(settings.idleMinutes);
  $<HTMLInputElement>('poll').value = String(settings.pollSeconds);
  $<HTMLInputElement>('retention').value = String(settings.retentionDays);
  $<HTMLTextAreaElement>('template').value = settings.reportTemplate;
  $<HTMLInputElement>('openAtLogin').checked = settings.openAtLogin;
  $('settingsMsg').textContent = '';
}
function openSettings() {
  fillSettings();
  dlg.showModal();
}
$('openSettings').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => dlg.close());

const ipcMessage = (err: unknown) => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
async function saveSecret(name: 'claude' | 'local', inputId: string) {
  const input = $<HTMLInputElement>(inputId);
  const v = input.value.trim();
  if (!v) return;
  try {
    settings = await api.setSecret(name, v);
    input.value = '';
    fillSettings();
    $('settingsMsg').textContent = 'キーを保存しました';
  } catch (err) {
    $('settingsMsg').textContent = `保存できませんでした: ${ipcMessage(err)}`;
  }
}
const onEnter = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    fn();
  }
};
$('saveKey').addEventListener('click', () => saveSecret('claude', 'apiKey'));
$('apiKey').addEventListener('keydown', onEnter(() => saveSecret('claude', 'apiKey')));
$('clearKey').addEventListener('click', async () => {
  settings = await api.setSecret('claude', null);
  fillSettings();
});
$('saveLocalKey').addEventListener('click', () => saveSecret('local', 'localKey'));
$('localKey').addEventListener('keydown', onEnter(() => saveSecret('local', 'localKey')));
$('clearLocalKey').addEventListener('click', async () => {
  settings = await api.setSecret('local', null);
  fillSettings();
});
$('testLocal').addEventListener('click', async () => {
  const url = $<HTMLInputElement>('localUrl').value.trim();
  $('localState').innerHTML = '<span class="spin"></span> 接続しています…';
  let res;
  try {
    res = await api.listLocalModels(url);
  } catch (err) {
    return void ($('localState').innerHTML = `<span class="err">URL が不正です: ${esc(ipcMessage(err))}</span>`);
  }
  if (!res.ok) return void ($('localState').innerHTML = `<span class="err">${esc(res.error)}</span>`);
  $('localModels').innerHTML = res.models.map((m) => `<option value="${esc(m)}"></option>`).join('');
  const host = new URL(url).hostname;
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  $('localState').innerHTML =
    `✓ 接続できました（モデル ${res.models.length} 個）` +
    (!loopback && url.startsWith('http:') ? '<br><span class="err">⚠ この PC 外のサーバーへ暗号化されていない http で送信します。社内ネットワーク内か確認してください。</span>' : '');
  if (!$<HTMLInputElement>('localModel').value && res.models[0]) $<HTMLInputElement>('localModel').value = res.models[0];
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
const lines = (id: string) =>
  $<HTMLTextAreaElement>(id)
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
const num = (id: string, fallback: number) => {
  const n = Math.round(Number($<HTMLInputElement>(id).value));
  return Number.isFinite(n) ? n : fallback;
};
$('saveSettings').addEventListener('click', async () => {
  try {
    settings = await api.setSettings({
      provider: (radios().find((r) => r.checked)?.value ?? 'claude') as 'claude' | 'local',
      model: $<HTMLSelectElement>('model').value,
      localBaseUrl: $<HTMLInputElement>('localUrl').value.trim() || 'http://localhost:11434/v1',
      localModel: $<HTMLInputElement>('localModel').value.trim(),
      redact: $<HTMLInputElement>('redact').checked,
      excludeKeywords: lines('exclude'),
      excludeApps: lines('excludeApps'),
      idleMinutes: Math.min(120, Math.max(1, num('idleMin', 5))),
      pollSeconds: Math.min(60, Math.max(1, num('poll', 5))),
      retentionDays: Math.min(3650, Math.max(0, num('retention', 0))),
      reportTemplate: $<HTMLTextAreaElement>('template').value,
      openAtLogin: $<HTMLInputElement>('openAtLogin').checked,
    });
    renderRec();
    dlg.close();
  } catch (err) {
    $('settingsMsg').textContent = `保存できませんでした: ${ipcMessage(err)}`;
  }
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
api.onStatus((s) => {
  status = s;
  renderRec();
});
setInterval(() => date === dayKey(Date.now()) && render(), 30_000);
window.addEventListener('resize', () => render());

(async () => {
  [settings, status] = await Promise.all([api.getSettings(), api.getStatus()]);
  renderRec();
  await load();
  if (!settings.onboarded) obDlg.showModal();
})();
