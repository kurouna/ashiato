import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { AshiatoApi } from '../preload';
import { DayData, JournalEvent, MODELS, PublicSettings, Status, StreamEvent, WorkBlock, dayKey, hhmm, startOfDay } from '../shared/types';
import { CAT_COLOR, CAT_LABEL, Timeline, appColor } from './timeline';

const api = (window as unknown as { ashiato: AshiatoApi }).ashiato;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let date = dayKey(Date.now());
let day: DayData | null = null;
let settings: PublicSettings;
let status: Status | null = null;

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
function fmtBytes(n: number) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
function fmtDur(ms: number) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}時間${String(m % 60).padStart(2, '0')}分` : `${m}分`;
}
function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
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
    evs.push(live.kind === 'idle' ? { t: 'idle', start: live.start, end: now, locked: live.locked } : { t: 'window', start: live.start, end: now, app: live.app, title: live.title });
  }
  if (day.liveCall) evs.push({ t: 'call', start: day.liveCall.start, end: Date.now(), app: day.liveCall.app, title: day.liveCall.title });
  return evs;
}

// ---------- load & render ----------
const timeline = new Timeline($('timeline'), $('tooltip'), async (ev, tip) => {
  if (!confirm(`この記録を削除しますか？

${tip}`)) return;
  await api.deleteEvent(date, ev);
  load();
});

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
  timeline.render({ date, events: evs, deletable: day?.events.length ?? 0, blocks: day?.ai.blocks ?? [], today: date === dayKey(Date.now()) });
  renderStats(evs);
  renderBlocks(day?.ai.blocks);
  if (!reportBusy && !editing) renderReport(day?.ai.report);
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
  renderSegmentStatus();
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

$('deleteDay').addEventListener('click', async () => {
  if (await api.deleteDay(date)) load();
});

// ---------- AI: blocks ----------
/** Which AI the next request goes to, in words, so a stale server/model setting is visible. */
function aiName() {
  if (settings.provider !== 'local') return `Claude（${settings.model}）`;
  let host = settings.localBaseUrl;
  try {
    host = new URL(settings.localBaseUrl).host;
  } catch {}
  return `ローカル LLM（${settings.localModel || 'モデル未設定'} @ ${host}）`;
}
const shortDay = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

const fmtSecs = (s: number) => (s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`);

/**
 * Live progress of one AI request: which phase it is in and for how long, so a slow (busy) server
 * reads as "still waiting" or "still arriving" instead of looking stuck.
 */
class Progress {
  readonly started = Date.now();
  readonly dest = aiName();
  phase: 'wait' | 'thinking' | 'text' = 'wait';
  chars = 0;

  on(e: StreamEvent) {
    if (e.kind === 'thinking' && this.phase === 'wait') this.phase = 'thinking';
    else if (e.kind === 'text') {
      this.phase = 'text';
      this.chars += e.data.length;
    }
  }

  secs() {
    return Math.round((Date.now() - this.started) / 1000);
  }

  text(receiving: string) {
    const t = this.secs();
    if (this.phase === 'wait') {
      const busy = t >= 20 && settings.provider === 'local' ? `（サーバーが混雑していると順番を待ちます。上限 ${settings.aiTimeoutMinutes} 分）` : '';
      return `${this.dest} の応答を待っています… ${fmtSecs(t)}${busy}`;
    }
    if (this.phase === 'thinking') return `${this.dest} が考えています… ${fmtSecs(t)}`;
    return `${receiving}… ${this.chars.toLocaleString()} 文字・${fmtSecs(t)}`;
  }
}

// One organise job at a time. It belongs to the day it was started for, which may not be the day on screen.
let segmentJob: { date: string; reqId: string; progress: Progress } | null = null;
let segmentNote = '';

function renderSegmentStatus() {
  const job = segmentJob;
  $<HTMLButtonElement>('segmentBtn').disabled = !!job;
  $('cancelSegment').classList.toggle('hidden', !job);
  if (job) {
    const text =
      job.date === date
        ? job.progress.text('整理結果を受信しています')
        : `${shortDay(job.date)} の作業を整理しています（${fmtSecs(job.progress.secs())}）。終わるとその日に保存されます`;
    return setStatus('segmentStatus', text, 'busy');
  }
  if (segmentNote) return setStatus('segmentStatus', segmentNote, segmentNote.startsWith('✓') ? 'muted' : 'err');
  setStatus('segmentStatus', day?.ai.blocksAt ? `${new Date(day.ai.blocksAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} に整理（${day.ai.model ?? ''}）` : '');
}
setInterval(() => segmentJob && renderSegmentStatus(), 1000);

$('segmentBtn').addEventListener('click', async () => {
  if (segmentJob) return;
  const job = (segmentJob = { date, reqId: newReq(), progress: new Progress() });
  segmentNote = '';
  streams.set(job.reqId, (e) => job.progress.on(e));
  renderSegmentStatus();
  const res = await api.segment(job.date, job.reqId);
  streams.delete(job.reqId);
  segmentJob = null;
  if (job.date !== date) {
    // finished for a day that is no longer on screen: say so here instead of leaving a spinner behind
    segmentNote = res.ok ? `✓ ${shortDay(job.date)} の作業を整理しました` : `${shortDay(job.date)} の整理に失敗しました: ${res.error}`;
    return renderSegmentStatus();
  }
  if (!res.ok) {
    segmentNote = res.error;
    return renderSegmentStatus();
  }
  if (day) day.ai = res.ai;
  render();
});
$('cancelSegment').addEventListener('click', () => segmentJob && api.cancel(segmentJob.reqId));

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
  const progress = new Progress();
  const tick = () => forDate === date && setStatus('reportStatus', progress.text('書いています'), 'busy');
  tick();
  const ticker = setInterval(tick, 1000);
  streams.set(reqId, (e) => {
    progress.on(e);
    if (forDate !== date) return;
    if (e.kind === 'thinking') {
      thinking += e.data;
      box.classList.remove('hidden');
      $('thinkingText').textContent = thinking;
    } else if (e.kind === 'text') {
      if (!text) box.open = false;
      text += e.data;
      $('reportBody').innerHTML = md(text);
    }
  });
  const res = await api.report(forDate, reqId);
  clearInterval(ticker);
  streams.delete(reqId);
  reportBusy = false;
  reportReq = null;
  btn.disabled = false;
  $('cancelReport').classList.add('hidden');
  // the user moved to another day meanwhile: the result is saved for forDate; just clear the busy state here
  if (forDate !== date) return renderReport(day?.ai.report);
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

/** The days 「足跡に聞く」 may read, from the period picker. */
function askRange(): { from?: string; to?: string } {
  const v = $<HTMLSelectElement>('askRange').value;
  const today = dayKey(Date.now());
  if (v === 'all') return {};
  if (v === 'custom') {
    const from = $<HTMLInputElement>('askFrom').value || undefined;
    const to = $<HTMLInputElement>('askTo').value || undefined;
    return from && to && from > to ? { from: to, to: from } : { from, to };
  }
  return { from: dayKey(Date.now() - (Number(v) - 1) * 86400_000), to: today };
}
$('askRange').addEventListener('change', () => {
  const custom = $<HTMLSelectElement>('askRange').value === 'custom';
  $('askCustom').classList.toggle('hidden', !custom);
  if (custom && !$<HTMLInputElement>('askFrom').value) {
    $<HTMLInputElement>('askFrom').value = dayKey(Date.now() - 6 * 86400_000);
    $<HTMLInputElement>('askTo').value = dayKey(Date.now());
  }
});

async function ask(q: string) {
  if (askReq || !q.trim()) return;
  const reqId = (askReq = newReq());
  $<HTMLButtonElement>('askBtn').disabled = true;
  $('cancelAsk').classList.remove('hidden');
  bubble('user', esc(q));
  const out = bubble(
    'bot',
    '<div class="tools"></div><details class="thinking hidden"><summary>思考の要約</summary><div class="th"></div></details><div class="md body"></div><div class="progress muted small"><span class="spin"></span> <span class="ptext"></span></div>',
  );
  const tools = out.querySelector('.tools')!;
  const th = out.querySelector('details')!;
  const body = out.querySelector('.body')!;
  const progressEl = out.querySelector('.progress') as HTMLElement;
  const progress = new Progress();
  const tick = () => (progressEl.querySelector('.ptext')!.textContent = progress.text('回答を受信しています'));
  tick();
  const ticker = setInterval(tick, 1000);
  let text = '';
  let thinking = '';
  streams.set(reqId, (e) => {
    progress.on(e);
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
  const res = await api.ask(q, reqId, askRange());
  clearInterval(ticker);
  progressEl.remove();
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
  if (d !== date) {
    timeline.reset();
    segmentNote = '';
  }
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
  if (status?.version) {
    $('appVersion').textContent = `v${status.version}`;
    $('settingsVersion').textContent = `足跡ジャーナル v${status.version}`;
  }
  const paused = settings.paused;
  const until = paused && settings.pausedUntil ? `（${new Date(settings.pausedUntil).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}まで）` : '';
  // right after launch the probe has not answered yet: that is not a failure
  const starting = settings.onboarded && !paused && status && !status.probeOk && status.probeReason === '起動中';
  const broken = settings.onboarded && !paused && status && !status.probeOk && !starting;
  $('recToggle').classList.toggle('paused', paused || !settings.onboarded);
  $('recToggle').classList.toggle('broken', !!broken);
  $('recLabel').textContent = !settings.onboarded ? '未開始' : paused ? `一時停止中${until}` : broken ? '記録できていません' : starting ? '記録を準備中…' : '記録中';
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
radios().forEach((r) =>
  r.addEventListener('change', () => {
    syncProviderBoxes();
    if (r.checked && r.value === 'local') probeLocal();
  }),
);

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
  localModels = [];
  renderModelSelect(settings.localModel);
  $('localState').textContent = '';
  $<HTMLInputElement>('localKey').placeholder = settings.hasLocalKey ? '保存済み' : '不要なら空のまま';
  $<HTMLInputElement>('redact').checked = settings.redact;
  $<HTMLInputElement>('aiTimeout').value = String(settings.aiTimeoutMinutes);
  $<HTMLInputElement>('detectCalls').checked = settings.detectCalls;
  $('folderList').innerHTML =
    settings.watchFolders.map((f, i) => `<li><span>${esc(f)}</span><button type="button" class="icon" data-rm="${i}" aria-label="削除">×</button></li>`).join('') || '<li class="muted">未登録</li>';
  $<HTMLTextAreaElement>('exclude').value = settings.excludeKeywords.join('\n');
  $<HTMLTextAreaElement>('excludeApps').value = settings.excludeApps.join('\n');
  $<HTMLInputElement>('idleMin').value = String(settings.idleMinutes);
  $<HTMLInputElement>('poll').value = String(settings.pollSeconds);
  $<HTMLInputElement>('retention').value = String(settings.retentionDays);
  api.dataStats().then((st) => {
    $('dataStats').textContent = st.days
      ? `現在の記録: ${st.days} 日分（${st.first} 〜 ${st.last}）・${fmtBytes(st.bytes)}`
      : '現在の記録: まだありません';
  });
  $<HTMLTextAreaElement>('template').value = settings.reportTemplate;
  $<HTMLInputElement>('openAtLogin').checked = settings.openAtLogin;
  $('settingsMsg').textContent = '';
}
// What the form held when it was opened; closing with something different asks first,
// so a server URL that was only tested (not saved) is never silently thrown away.
let formSnapshot = '';
function formState() {
  return JSON.stringify([
    radios().find((r) => r.checked)?.value,
    $<HTMLSelectElement>('model').value,
    $<HTMLInputElement>('localUrl').value.trim(),
    chosenModel(),
    $<HTMLInputElement>('redact').checked,
    $<HTMLInputElement>('aiTimeout').value,
    $<HTMLInputElement>('detectCalls').checked,
    $<HTMLTextAreaElement>('exclude').value,
    $<HTMLTextAreaElement>('excludeApps').value,
    $<HTMLInputElement>('idleMin').value,
    $<HTMLInputElement>('poll').value,
    $<HTMLInputElement>('retention').value,
    $<HTMLTextAreaElement>('template').value,
    $<HTMLInputElement>('openAtLogin').checked,
  ]);
}
const aiFormChanged = () =>
  (radios().find((r) => r.checked)?.value ?? 'claude') !== settings.provider ||
  $<HTMLInputElement>('localUrl').value.trim() !== settings.localBaseUrl ||
  chosenModel() !== settings.localModel;

function openSettings() {
  fillSettings();
  formSnapshot = formState();
  dlg.showModal();
  if (settings.provider === 'local') probeLocal();
}
function closeSettings() {
  if (formState() !== formSnapshot && !confirm('保存していない変更があります。保存せずに閉じますか？\n\n（変更を反映するには「保存」を押してください）')) return;
  dlg.close();
}
$('openSettings').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', closeSettings);
// Esc closes a <dialog> by itself; route it through the same check
dlg.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeSettings();
});

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
// Local model picker: a real <select> filled from the server, plus a free-text escape hatch.
// (A datalist filters its suggestions by the text already in the box, so a prefilled name hid every other model.)
const MANUAL = '__manual__';
let localModels: string[] = [];
let probeSeq = 0;
const modelSel = $<HTMLSelectElement>('localModelSel');
const modelInput = $<HTMLInputElement>('localModel');

function renderModelSelect(current: string) {
  const opts = [...localModels];
  if (current && !opts.includes(current)) opts.unshift(current);
  const missing = (m: string) => localModels.length > 0 && !localModels.includes(m);
  modelSel.innerHTML = [
    ...(opts.length ? [] : [`<option value="" disabled>接続するとモデルの一覧が表示されます</option>`]),
    ...opts.map((m) => `<option value="${esc(m)}">${esc(m)}${missing(m) ? '（サーバーに見つかりません）' : ''}</option>`),
    `<option value="${MANUAL}">その他（モデル名を入力）…</option>`,
  ].join('');
  modelSel.value = current || opts[0] || '';
  if (!modelSel.value && !opts.length) modelSel.selectedIndex = 0;
  syncManual();
}
function syncManual() {
  const manual = modelSel.value === MANUAL;
  modelInput.classList.toggle('hidden', !manual);
  if (manual) modelInput.focus();
}
const chosenModel = () => (modelSel.value === MANUAL ? modelInput.value.trim() : modelSel.value);
modelSel.addEventListener('change', syncManual);

async function probeLocal() {
  const url = $<HTMLInputElement>('localUrl').value.trim();
  if (!url) return;
  const seq = ++probeSeq;
  const keep = chosenModel() || settings.localModel;
  $('localState').innerHTML = '<span class="spin"></span> 接続しています…';
  let res;
  try {
    res = await api.listLocalModels(url);
  } catch (err) {
    res = { ok: false as const, error: ipcMessage(err) };
  }
  if (seq !== probeSeq) return; // a newer probe (URL edited again) wins
  if (!res.ok) {
    localModels = [];
    renderModelSelect(keep);
    return void ($('localState').innerHTML = `<span class="err">${esc(res.error)}</span>`);
  }
  localModels = res.models;
  renderModelSelect(keep && (res.models.includes(keep) || keep === settings.localModel) ? keep : (res.models[0] ?? ''));
  const host = new URL(url).hostname;
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  $('localState').innerHTML =
    (res.models.length ? `✓ 接続できました（モデル ${res.models.length} 個）` : '⚠ 接続できましたが、モデルがありません。サーバー側でモデルを用意してください（例: ollama pull qwen3:14b）') +
    (aiFormChanged() ? '<br><b>「保存」を押すと、この接続先とモデルが使われます。</b>' : '') +
    (!loopback && url.startsWith('http:') ? '<br><span class="err">⚠ この PC 外のサーバーへ暗号化されていない http で送信します。社内ネットワーク内か確認してください。</span>' : '');
}
$('testLocal').addEventListener('click', probeLocal);
$('localUrl').addEventListener('change', probeLocal);
$('localUrl').addEventListener('keydown', onEnter(probeLocal));
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
    const saved = await api.setSettings({
      provider: (radios().find((r) => r.checked)?.value ?? 'claude') as 'claude' | 'local',
      model: $<HTMLSelectElement>('model').value,
      localBaseUrl: $<HTMLInputElement>('localUrl').value.trim() || 'http://localhost:11434/v1',
      localModel: chosenModel(),
      redact: $<HTMLInputElement>('redact').checked,
      aiTimeoutMinutes: Math.min(60, Math.max(1, num('aiTimeout', 10))),
      detectCalls: $<HTMLInputElement>('detectCalls').checked,
      excludeKeywords: lines('exclude'),
      excludeApps: lines('excludeApps'),
      idleMinutes: Math.min(120, Math.max(1, num('idleMin', 5))),
      pollSeconds: Math.min(60, Math.max(1, num('poll', 5))),
      retentionDays: Math.min(3650, Math.max(0, num('retention', 0))),
      reportTemplate: $<HTMLTextAreaElement>('template').value,
      openAtLogin: $<HTMLInputElement>('openAtLogin').checked,
    });
    const { retentionKept, ...rest } = saved;
    settings = rest;
    renderRec();
    if (retentionKept) {
      // the user backed out of deleting old days: everything else is saved, the period is not
      $<HTMLInputElement>('retention').value = String(settings.retentionDays);
      $('settingsMsg').textContent = '保存期間は変更しませんでした（ほかの設定は保存しました）';
      return;
    }
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
