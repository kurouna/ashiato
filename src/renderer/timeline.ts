import { Category, JournalEvent, WorkBlock, hhmm, startOfDay } from '../shared/types';

/**
 * The day view: lanes of spans and marks on a shared time axis.
 * Plain DOM (not SVG) so labels can ellipsize inside bands; hit-testing is done per lane by time,
 * so even a 1-px band or a mark can be hovered and clicked.
 */

export const CAT_LABEL: Record<Category, string> = {
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
export const CAT_COLOR: Record<Category, string> = {
  coding: '#7aa2f7',
  review: '#bb9af7',
  debugging: '#f7768e',
  research: '#2ac3de',
  writing: '#9ece6a',
  meeting: '#e0af68',
  communication: '#ff9e64',
  design: '#73daca',
  admin: '#a9b1d6',
  break: '#94a3b8',
  other: '#787c99',
};

type LaneId = 'work' | 'call' | 'app' | 'file' | 'git' | 'memo';
const LANES: { id: LaneId; label: string; cls: string }[] = [
  { id: 'work', label: '作業', cls: 'tall' },
  { id: 'call', label: '会議', cls: '' },
  { id: 'app', label: 'アプリ', cls: '' },
  { id: 'file', label: 'ファイル', cls: 'thin' },
  { id: 'git', label: 'git', cls: '' },
  { id: 'memo', label: 'メモ', cls: '' },
];

/** One mark per kind of git action and for memos, so they read apart at a glance. */
export const MARKS: Record<string, { label: string; svg: string }> = {
  commit: { label: 'コミット', svg: '<svg viewBox="0 0 16 16"><path d="M0 8h4.5M11.5 8H16" class="ln"/><circle cx="8" cy="8" r="3.6" class="fill"/></svg>' },
  merge: { label: 'マージ', svg: '<svg viewBox="0 0 16 16"><path d="M4 2v12M4 5c0 4 8 3 8 7" class="ln"/><circle cx="4" cy="3" r="2.2" class="fill"/><circle cx="12" cy="12.5" r="2.2" class="fill"/></svg>' },
  pull: { label: 'プル', svg: '<svg viewBox="0 0 16 16"><path d="M8 1.5v9M4.5 7 8 10.5 11.5 7M2.5 14h11" class="ln"/></svg>' },
  rebase: { label: 'リベース', svg: '<svg viewBox="0 0 16 16"><path d="M13 6a5 5 0 0 0-9-2M3 10a5 5 0 0 0 9 2" class="ln"/><path d="M4 1.5V4.5H7M12 14.5V11.5H9" class="ln"/></svg>' },
  memo: { label: 'メモ', svg: '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h11v8h-6l-3.5 3v-3h-1.5z" class="fill"/></svg>' },
};

interface Item {
  lane: LaneId;
  start: number;
  end: number; // == start for marks
  mark?: string;
  label?: string;
  color?: string;
  cls?: string;
  tip: string;
  /** the recorded event behind it, when it can be deleted */
  event?: JournalEvent;
}

export interface TimelineData {
  date: string;
  events: JournalEvent[];
  /** events[0 .. deletable) are stored ones; the rest are live (still open) */
  deletable: number;
  blocks: WorkBlock[];
  today: boolean;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 96;
const HOUR = 3600_000;
const LABEL_W = 64;

export class Timeline {
  private data: TimelineData | null = null;
  private items: Item[] = [];
  private byLane = new Map<LaneId, Item[]>();
  private t0 = 0;
  private t1 = 0;
  private zoom = 1;
  private selected: Item | null = null;
  private hovered: Item | null = null;
  private els!: { toolbar: HTMLElement; range: HTMLElement; labels: HTMLElement; scroll: HTMLElement; canvas: HTMLElement; detail: HTMLElement; legend: HTMLElement };
  private itemEl = new Map<Item, HTMLElement>();
  private labelled: { el: HTMLElement; left: number; width: number }[] = [];

  constructor(
    private host: HTMLElement,
    private tooltip: HTMLElement,
    private onDelete: (ev: JournalEvent, tip: string) => void,
  ) {
    host.innerHTML = `
      <div class="tl-toolbar">
        <div class="tl-zoom" role="group" aria-label="拡大・縮小">
          <button type="button" class="icon" data-z="out" title="縮小 (−)" aria-label="縮小">−</button>
          <button type="button" class="icon" data-z="in" title="拡大 (＋)" aria-label="拡大">＋</button>
          <button type="button" class="ghost small" data-z="fit" title="1 日全体を表示 (0)">全体</button>
          <button type="button" class="ghost small" data-z="1h">1 時間</button>
          <button type="button" class="ghost small" data-z="3h">3 時間</button>
        </div>
        <span class="tl-range muted small"></span>
        <span class="muted small tl-hint">Shift（または Ctrl）+ ホイールで拡大・縮小、ドラッグで移動、クリックで詳細</span>
      </div>
      <div class="tl-body">
        <div class="tl-labels"></div>
        <div class="tl-scroll" tabindex="0" aria-label="タイムライン"><div class="tl-canvas"></div></div>
      </div>
      <div class="tl-legend"></div>
      <div class="tl-detail hidden" aria-live="polite"></div>`;
    const q = (s: string) => host.querySelector(s) as HTMLElement;
    this.els = { toolbar: q('.tl-toolbar'), range: q('.tl-range'), labels: q('.tl-labels'), scroll: q('.tl-scroll'), canvas: q('.tl-canvas'), detail: q('.tl-detail'), legend: q('.tl-legend') };
    this.bind();
  }

  /** New day: back to the whole-day view. */
  reset() {
    this.zoom = 1;
    this.selected = null;
    this.els.scroll.scrollLeft = 0;
  }

  render(data: TimelineData) {
    this.data = data;
    this.build();
    this.draw();
  }

  // ---------- model ----------
  private build() {
    const d = this.data!;
    const items: Item[] = [];
    const fmt = (s: number, e: number) => `${hhmm(s)}–${hhmm(e)}（${dur(e - s)}）`;
    const dayStart = startOfDay(d.date);
    const toMs = (hm: string) => {
      const [h, m] = hm.split(':').map(Number);
      return dayStart + (h * 60 + m) * 60_000;
    };
    for (const b of d.blocks) {
      const s = toMs(b.start);
      const e = Math.max(toMs(b.end), s + 60_000);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      items.push({
        lane: 'work',
        start: s,
        end: e,
        label: b.title,
        color: CAT_COLOR[b.category] ?? '#888',
        cls: b.category === 'break' ? 'is-break' : '',
        tip: `${fmt(s, e)} ${CAT_LABEL[b.category] ?? ''}${b.project ? ` · ${b.project}` : ''}\n${b.title}\n${b.summary}`,
      });
    }
    d.events.forEach((e, i) => {
      const event = i < d.deletable ? e : undefined;
      if (e.t === 'window') {
        items.push({ lane: 'app', start: e.start, end: e.end, label: e.app, color: appColor(e.app), tip: `${fmt(e.start, e.end)}\n${e.app}\n${e.title}`, event });
      } else if (e.t === 'idle') {
        items.push({ lane: 'app', start: e.start, end: e.end, cls: e.locked ? 'is-locked' : 'is-idle', label: e.locked ? '離席' : '', tip: `${fmt(e.start, e.end)}\n${e.locked ? '画面ロック・離席' : 'キー・マウス操作なし'}`, event });
      } else if (e.t === 'call') {
        items.push({ lane: 'call', start: e.start, end: e.end, cls: 'is-call', label: e.app || '会議', tip: `${fmt(e.start, e.end)} 会議・通話\n${[e.app, e.title].filter(Boolean).join(' · ')}`, event });
      } else if (e.t === 'file') {
        items.push({ lane: 'file', start: e.ts, end: e.ts, cls: 'is-file', tip: `${hhmm(e.ts)} ファイル編集\n${e.path}`, event });
      } else if (e.t === 'commit') {
        items.push({ lane: 'git', start: e.ts, end: e.ts, mark: 'commit', tip: `${hhmm(e.ts)} コミット「${e.repo}」\n${e.subject}`, event });
      } else if (e.t === 'gitop') {
        const mark = MARKS[e.action] ? e.action : 'merge';
        items.push({ lane: 'git', start: e.ts, end: e.ts, mark, tip: `${hhmm(e.ts)} ${MARKS[mark].label}（取り込み）「${e.repo}」\n${e.text}`, event });
      } else if (e.t === 'memo') {
        items.push({ lane: 'memo', start: e.ts, end: e.ts, mark: 'memo', tip: `${hhmm(e.ts)} メモ\n${e.text}`, event });
      }
    });
    this.items = items;
    this.byLane = new Map();
    for (const it of items) {
      const list = this.byLane.get(it.lane) ?? [];
      list.push(it);
      this.byLane.set(it.lane, list);
    }
    for (const list of this.byLane.values()) list.sort((a, b) => a.start - b.start);

    // whole-hour window around the recorded activity, at least 4 hours
    const times = items.flatMap((i) => [i.start, i.end]);
    if (!times.length) {
      this.t0 = dayStart + 9 * HOUR;
      this.t1 = dayStart + 18 * HOUR;
      return;
    }
    let t0 = Math.floor((Math.min(...times) - dayStart) / HOUR) * HOUR + dayStart;
    let t1 = Math.ceil((Math.max(...times) - dayStart) / HOUR) * HOUR + dayStart;
    if (t1 - t0 < 4 * HOUR) t1 = t0 + 4 * HOUR;
    this.t0 = Math.max(t0, dayStart);
    this.t1 = Math.min(t1, dayStart + 24 * HOUR);
    if (this.selected) this.selected = this.items.find((i) => i.lane === this.selected!.lane && i.start === this.selected!.start && i.tip === this.selected!.tip) ?? null;
  }

  private lanesShown(): (typeof LANES)[number][] {
    return LANES.filter((l) => l.id === 'app' || this.byLane.get(l.id)?.length);
  }

  // ---------- geometry ----------
  private viewW() {
    return Math.max(300, this.els.scroll.clientWidth);
  }
  private canvasW() {
    return Math.round(this.viewW() * this.zoom);
  }
  private x(t: number) {
    return ((t - this.t0) / (this.t1 - this.t0)) * this.canvasW();
  }
  private timeAt(px: number) {
    return this.t0 + (px / this.canvasW()) * (this.t1 - this.t0);
  }
  private pxPerHour() {
    return (this.canvasW() / (this.t1 - this.t0)) * HOUR;
  }

  // ---------- drawing ----------
  private draw() {
    const { canvas, labels } = this.els;
    const W = this.canvasW();
    canvas.style.width = `${W}px`;
    this.itemEl.clear();
    this.labelled = [];
    const lanes = this.lanesShown();
    labels.innerHTML = `<div class="tl-axis-pad"></div>` + lanes.map((l) => `<div class="tl-label ${l.cls}">${l.label}</div>`).join('');

    // axis: tick spacing follows the zoom
    const pph = this.pxPerHour();
    const step = pph >= 900 ? 5 : pph >= 420 ? 10 : pph >= 200 ? 15 : pph >= 110 ? 30 : pph >= 45 ? 60 : 120;
    const ticks: string[] = [];
    const first = Math.ceil(this.t0 / (step * 60_000)) * step * 60_000;
    for (let t = first; t <= this.t1; t += step * 60_000) {
      const major = new Date(t).getMinutes() === 0;
      const px = this.x(t);
      const edge = px < 18 ? ' edge-l' : px > W - 18 ? ' edge-r' : '';
      ticks.push(`<div class="tl-tick${major ? ' major' : ''}${edge}" style="left:${px}px"><span>${major ? `${new Date(t).getHours()}:00` : hhmm(t)}</span></div>`);
    }

    const frag = document.createDocumentFragment();
    const axis = document.createElement('div');
    axis.className = 'tl-axis';
    axis.innerHTML = ticks.join('');
    frag.appendChild(axis);
    const grid = document.createElement('div');
    grid.className = 'tl-grid';
    grid.innerHTML = ticks.join('');
    frag.appendChild(grid);

    for (const lane of lanes) {
      const row = document.createElement('div');
      row.className = `tl-lane ${lane.cls}`;
      row.dataset.lane = lane.id;
      for (const it of this.byLane.get(lane.id) ?? []) {
        const el = document.createElement('div');
        if (it.mark) {
          el.className = `tl-mark mk-${it.mark}`;
          el.style.left = `${this.x(it.start)}px`;
          el.innerHTML = MARKS[it.mark].svg;
        } else if (it.start === it.end) {
          el.className = `tl-tick-item ${it.cls ?? ''}`;
          el.style.left = `${this.x(it.start)}px`;
        } else {
          const left = this.x(it.start);
          const width = Math.max(1, this.x(it.end) - left);
          el.className = `tl-span ${it.cls ?? ''}`;
          el.style.left = `${left}px`;
          el.style.width = `${width}px`;
          if (it.color) {
            el.style.setProperty('--c', it.color);
            el.style.color = inkFor(it.color);
          }
          // a label only where it fits; the band itself always stays hoverable
          if (it.label && width >= (lane.id === 'work' ? 36 : 44)) {
            el.innerHTML = `<span>${esc(it.label)}</span>`;
            this.labelled.push({ el: el.firstElementChild as HTMLElement, left, width });
          }
        }
        if (it === this.selected) el.classList.add('selected');
        this.itemEl.set(it, el);
        row.appendChild(el);
      }
      frag.appendChild(row);
    }
    const d = this.data!;
    if (d.today && Date.now() >= this.t0 && Date.now() <= this.t1) {
      const now = document.createElement('div');
      now.className = 'tl-now';
      now.style.left = `${this.x(Date.now())}px`;
      now.title = `現在 ${hhmm(Date.now())}`;
      frag.appendChild(now);
    }
    const cursor = document.createElement('div');
    cursor.className = 'tl-cursor hidden';
    cursor.innerHTML = '<span></span>';
    frag.appendChild(cursor);
    canvas.replaceChildren(frag);

    this.drawChrome();
  }

  /** A band that starts off-screen to the left slides its label along, like a sticky header. */
  private pinLabels() {
    const sl = this.els.scroll.scrollLeft;
    for (const { el, left, width } of this.labelled) {
      const shift = Math.max(0, Math.min(sl - left, width - 60));
      el.style.marginLeft = shift > 0 ? `${shift}px` : '';
    }
  }

  private drawChrome() {
    this.pinLabels();
    // marks poke a few px past the edges; only offer a scrollbar when there is something to scroll to
    this.els.scroll.style.overflowX = this.zoom <= MIN_ZOOM + 1e-6 ? 'hidden' : 'auto';
    const view = this.els.scroll;
    const a = this.timeAt(view.scrollLeft);
    const b = this.timeAt(view.scrollLeft + this.viewW());
    this.els.range.textContent = this.zoom <= 1.001 ? `${hhmm(this.t0)}–${hhmm(this.t1)}` : `${hhmm(a)}–${hhmm(b)} を表示中（×${this.zoom < 10 ? this.zoom.toFixed(1) : Math.round(this.zoom)}）`;
    (this.els.toolbar.querySelector('[data-z=out]') as HTMLButtonElement).disabled = this.zoom <= MIN_ZOOM;
    (this.els.toolbar.querySelector('[data-z=in]') as HTMLButtonElement).disabled = this.zoom >= MAX_ZOOM;

    // legend: only what is on screen today
    const cats = new Set(this.data!.blocks.map((b) => b.category));
    const marks = new Set(this.items.filter((i) => i.mark).map((i) => i.mark!));
    const parts = [
      ...[...cats].map((c) => `<span><i class="sw ${c === 'break' ? 'is-break' : ''}" style="--c:${CAT_COLOR[c]}"></i>${CAT_LABEL[c]}</span>`),
      ...(this.byLane.get('call')?.length ? ['<span><i class="sw is-call"></i>会議・通話</span>'] : []),
      ...(this.items.some((i) => i.cls === 'is-idle') ? ['<span><i class="sw is-idle"></i>操作なし</span>'] : []),
      ...(this.items.some((i) => i.cls === 'is-locked') ? ['<span><i class="sw is-locked"></i>離席</span>'] : []),
      ...['commit', 'merge', 'pull', 'rebase', 'memo'].filter((m) => marks.has(m)).map((m) => `<span class="lg-mark mk-${m}">${MARKS[m].svg}${MARKS[m].label}</span>`),
    ];
    this.els.legend.innerHTML = parts.join('');
    this.drawDetail();
  }

  private drawDetail() {
    const it = this.selected;
    const el = this.els.detail;
    el.classList.toggle('hidden', !it);
    if (!it) return;
    const [head, ...rest] = it.tip.split('\n');
    el.innerHTML = `<div class="tl-detail-text"><b>${esc(head)}</b>${rest.filter(Boolean).map((r) => `<div>${esc(r)}</div>`).join('')}</div>
      <div class="tl-detail-actions">
        ${it.end > it.start ? '<button type="button" class="ghost small" data-act="zoom">この範囲を拡大</button>' : ''}
        ${it.event ? '<button type="button" class="ghost small danger" data-act="delete">この記録を削除</button>' : ''}
        <button type="button" class="icon" data-act="close" aria-label="閉じる">×</button>
      </div>`;
  }

  // ---------- zoom ----------
  private setZoom(z: number, anchorPx = this.viewW() / 2) {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    if (Math.abs(next - this.zoom) < 1e-6) return;
    const t = this.timeAt(this.els.scroll.scrollLeft + anchorPx);
    this.zoom = next;
    this.draw();
    this.els.scroll.scrollLeft = this.x(t) - anchorPx;
    this.drawChrome();
  }

  private zoomTo(a: number, b: number) {
    const span = Math.max(b - a, 10 * 60_000);
    const pad = span * 0.08;
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (this.t1 - this.t0) / (span + 2 * pad)));
    this.draw();
    this.els.scroll.scrollLeft = this.x(a - pad);
    this.drawChrome();
  }

  // ---------- interaction ----------
  private hit(e: MouseEvent): Item | null {
    const lane = [...this.els.canvas.querySelectorAll<HTMLElement>('.tl-lane')].find((l) => {
      const r = l.getBoundingClientRect();
      return e.clientY >= r.top && e.clientY < r.bottom;
    });
    if (!lane) return null;
    const list = this.byLane.get(lane.dataset.lane as LaneId) ?? [];
    const rect = this.els.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = this.timeAt(px);
    // inside a band first (the last drawn wins, as on screen), then the nearest mark/band within reach
    let inside: Item | null = null;
    for (const it of list) if (it.end > it.start && it.start <= t && t <= it.end) inside = it;
    if (inside) return inside;
    let best: Item | null = null;
    let bestD = 9; // px
    for (const it of list) {
      const d = it.end > it.start ? Math.min(Math.abs(this.x(it.start) - px), Math.abs(this.x(it.end) - px)) : Math.abs(this.x(it.start) - px);
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    return best;
  }

  private setHover(it: Item | null, e?: MouseEvent) {
    if (this.hovered && this.hovered !== it) this.itemEl.get(this.hovered)?.classList.remove('hover');
    this.hovered = it;
    if (!it || !e) return this.tooltip.classList.add('hidden');
    this.itemEl.get(it)?.classList.add('hover');
    this.tooltip.textContent = it.tip;
    this.tooltip.classList.remove('hidden');
    const r = this.tooltip.getBoundingClientRect();
    this.tooltip.style.left = `${Math.min(e.clientX + 14, innerWidth - r.width - 8)}px`;
    this.tooltip.style.top = `${Math.min(e.clientY + 16, innerHeight - r.height - 8)}px`;
  }

  private bind() {
    const { scroll, canvas, toolbar, detail } = this.els;

    toolbar.addEventListener('click', (e) => {
      const z = (e.target as HTMLElement).closest('[data-z]')?.getAttribute('data-z');
      if (z === 'in') this.setZoom(this.zoom * 1.6);
      else if (z === 'out') this.setZoom(this.zoom / 1.6);
      else if (z === 'fit') this.setZoom(1);
      else if (z === '1h' || z === '3h') {
        const span = (z === '1h' ? 1 : 3) * HOUR;
        const center = this.selected ? (this.selected.start + this.selected.end) / 2 : this.data?.today ? Math.min(Date.now(), this.t1) - span / 2 : this.timeAt(scroll.scrollLeft + this.viewW() / 2);
        this.zoomTo(center - span / 2, center + span / 2);
      }
    });

    scroll.addEventListener(
      'wheel',
      (e) => {
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) return; // plain wheel scrolls the page as usual
        e.preventDefault();
        // with Shift held, Chromium may deliver the wheel as horizontal (deltaX)
        const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (!delta) return;
        const rect = scroll.getBoundingClientRect();
        this.setZoom(this.zoom * Math.exp(-delta * 0.0025), e.clientX - rect.left);
      },
      { passive: false },
    );
    scroll.addEventListener('scroll', () => this.drawChrome());

    // drag to pan; a click that did not move selects
    let drag: { x: number; left: number; moved: boolean } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, left: scroll.scrollLeft, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = e.clientX - drag.x;
        if (Math.abs(dx) > 4) drag.moved = true;
        if (drag.moved) {
          scroll.scrollLeft = drag.left - dx;
          canvas.classList.add('dragging');
          return this.setHover(null);
        }
      }
      const cursor = canvas.querySelector('.tl-cursor') as HTMLElement | null;
      if (cursor) {
        const px = e.clientX - canvas.getBoundingClientRect().left;
        cursor.classList.remove('hidden');
        cursor.style.left = `${px}px`;
        cursor.firstElementChild!.textContent = hhmm(this.timeAt(px));
      }
      this.setHover(this.hit(e), e);
    });
    canvas.addEventListener('pointerup', (e) => {
      const wasDrag = drag?.moved;
      drag = null;
      canvas.classList.remove('dragging');
      if (wasDrag) return;
      this.select(this.hit(e));
    });
    canvas.addEventListener('pointerleave', () => {
      this.setHover(null);
      canvas.querySelector('.tl-cursor')?.classList.add('hidden');
    });
    canvas.addEventListener('dblclick', (e) => {
      const it = this.hit(e);
      if (it && it.end > it.start) this.zoomTo(it.start, it.end);
    });
    canvas.addEventListener('contextmenu', (e) => {
      const it = this.hit(e);
      if (!it?.event) return;
      e.preventDefault();
      this.onDelete(it.event, it.tip);
    });

    scroll.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=' || e.key === ';') this.setZoom(this.zoom * 1.6);
      else if (e.key === '-') this.setZoom(this.zoom / 1.6);
      else if (e.key === '0') this.setZoom(1);
      else if (e.key === 'Escape') this.select(null);
      else return;
      e.preventDefault();
    });

    detail.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
      const it = this.selected;
      if (act === 'close') this.select(null);
      else if (act === 'zoom' && it) this.zoomTo(it.start, it.end);
      else if (act === 'delete' && it?.event) this.onDelete(it.event, it.tip);
    });

    new ResizeObserver(() => this.data && this.draw()).observe(scroll);
  }

  private select(it: Item | null) {
    if (this.selected) this.itemEl.get(this.selected)?.classList.remove('selected');
    this.selected = it;
    if (it) this.itemEl.get(it)?.classList.add('selected');
    this.drawDetail();
  }
}

// ---------- helpers ----------
function dur(ms: number) {
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))}秒`;
  return m >= 60 ? `${Math.floor(m / 60)}時間${String(m % 60).padStart(2, '0')}分` : `${m}分`;
}

function hashHue(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function appColor(app: string) {
  return app === '(非公開)' ? '#9aa3b2' : `hsl(${hashHue(app.toLowerCase())} 60% 62%)`;
}

/** Dark text on light bands, white on dark ones. */
function inkFor(color: string): string {
  let r = 0;
  let g = 0;
  let b = 0;
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  const hsl = color.match(/^hsl\((\d+)\s+(\d+)%\s+(\d+)%\)$/);
  if (hex) {
    const n = parseInt(hex[1], 16);
    [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  } else if (hsl) {
    return Number(hsl[3]) >= 55 ? '#14161c' : '#ffffff';
  } else return '#14161c';
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.5 ? '#14161c' : '#ffffff';
}

function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
