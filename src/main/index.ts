import { BrowserWindow, Menu, Notification, Tray, app, clipboard, dialog, globalShortcut, ipcMain, nativeImage, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as z from 'zod';
import { Settings, Status, StreamEvent, dayKey } from '../shared/types';
import { Ai, LocalProvider } from './ai';
import { Recorder } from './recorder';
import { AiPatch, Store, assertDate } from './store';

const MEMO_SHORTCUT = 'CommandOrControl+Alt+J';

// Keep the journal out of Roaming AppData so it never travels with roaming profiles / profile backups.
if (process.platform === 'win32' && process.env.LOCALAPPDATA) app.setPath('userData', path.join(process.env.LOCALAPPDATA, 'Ashiato'));
// separate profile for development / demos; never honoured by packaged builds
if (!app.isPackaged && process.env.ASHIATO_USER_DATA) app.setPath('userData', path.resolve(process.env.ASHIATO_USER_DATA));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);

let store: Store;
let recorder: Recorder;
let ai: Ai;
let mainWin: BrowserWindow | null = null;
let memoWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let shortcutOk = true;

const rendererDir = path.join(__dirname, 'renderer');
const rendererUrl = pathToFileURL(rendererDir).href + '/';
const preload = path.join(__dirname, 'preload.js');
const webPreferences = { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, spellcheck: false };

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: '足跡ジャーナル',
    icon: appIcon(),
    autoHideMenuBar: true,
    show: false,
    webPreferences,
  });
  mainWin.loadFile(path.join(rendererDir, 'index.html'));
  mainWin.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) mainWin?.show();
    const shot = !app.isPackaged && process.env.ASHIATO_SNAPSHOT;
    if (shot) {
      setTimeout(async () => {
        const img = await mainWin!.webContents.capturePage();
        fs.writeFileSync(shot, img.toPNG());
      }, Number(process.env.ASHIATO_SNAPSHOT_DELAY ?? 4000));
    }
  });
  mainWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWin?.hide();
    noticeTrayOnce();
  });
}

function noticeTrayOnce() {
  const marker = path.join(app.getPath('userData'), '.tray-notice-shown');
  if (fs.existsSync(marker)) return;
  fs.writeFileSync(marker, '');
  const body = '記録はタスクトレイで続いています。終了するときはトレイアイコンを右クリックしてください。';
  if (process.platform === 'win32' && tray) tray.displayBalloon({ title: '足跡ジャーナル', content: body, iconType: 'info' });
  else if (Notification.isSupported()) new Notification({ title: '足跡ジャーナル', body }).show();
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  mainWin!.show();
  mainWin!.focus();
}

function toggleMemo() {
  if (memoWin && !memoWin.isDestroyed()) {
    if (memoWin.isVisible()) memoWin.hide();
    else {
      memoWin.show();
      memoWin.focus();
    }
    return;
  }
  memoWin = new BrowserWindow({
    width: 520,
    height: 132,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    show: false,
    webPreferences,
  });
  memoWin.loadFile(path.join(rendererDir, 'memo.html'));
  memoWin.once('ready-to-show', () => {
    memoWin?.show();
    memoWin?.focus();
  });
  memoWin.on('blur', () => memoWin?.hide());
}

// ---------- pause ----------
function pause(minutes: number | 'today' | null) {
  if (minutes === null) return applySettings({ paused: false, pausedUntil: null });
  const until = minutes === 'today' ? new Date(new Date().setHours(24, 0, 0, 0)).getTime() : Date.now() + minutes * 60_000;
  return applySettings({ paused: true, pausedUntil: until });
}

function refreshTray() {
  if (!tray) return;
  const s = store.getSettings();
  const until = s.paused && s.pausedUntil ? `（${new Date(s.pausedUntil).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} まで）` : '';
  tray.setImage(trayIcon(s.paused));
  tray.setToolTip(`足跡ジャーナル v${app.getVersion()} — ${s.paused ? `一時停止中${until}` : '記録中'}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '開く', click: showMain },
      { label: `クイックメモ (${MEMO_SHORTCUT.replace('CommandOrControl', 'Ctrl')})`, click: toggleMemo },
      { type: 'separator' },
      s.paused
        ? { label: `記録を再開${until}`, click: () => pause(null) }
        : {
            label: '記録を一時停止',
            submenu: [
              { label: '30 分', click: () => pause(30) },
              { label: '1 時間', click: () => pause(60) },
              { label: '今日はもう記録しない', click: () => pause('today') },
              { label: '再開するまで', click: () => applySettings({ paused: true, pausedUntil: null }) },
            ],
          },
      { type: 'separator' },
      { label: '終了', click: () => app.quit() },
    ]),
  );
}

function applySettings(patch: Partial<Settings>) {
  const prev = store.getSettings();
  if (patch.paused === false) patch.pausedUntil = null;
  const next = store.updateSettings(patch);
  if (patch.openAtLogin !== undefined && app.isPackaged) {
    // the portable build runs from a temp folder; register the real exe instead
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    app.setLoginItemSettings({ openAtLogin: next.openAtLogin, path: exe, args: ['--hidden'] });
  }
  if (patch.retentionDays !== undefined) store.purgeExpired();
  recorder.reconfigure(prev);
  refreshTray();
  broadcast('settings:changed', store.getPublicSettings());
  return store.getPublicSettings();
}

function status(): Status {
  const h = recorder.health();
  return { version: app.getVersion(), recording: !store.getSettings().paused, probeOk: h.ok, probeReason: h.reason, lastSampleAt: h.lastSampleAt, shortcutOk, destination: ai.destination(), watchErrors: recorder.watchErrors };
}

function broadcast(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

function streamTo(sender: Electron.WebContents, reqId: string) {
  return (kind: StreamEvent['kind'], data: string) => {
    if (!sender.isDestroyed()) sender.send('ai:stream', { reqId, kind, data } satisfies StreamEvent);
  };
}

// ---------- IPC ----------
/** Every handler only answers our own pages, never a frame that navigated elsewhere. */
function handle(channel: string, fn: (e: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!e.senderFrame?.url.startsWith(rendererUrl)) throw new Error('forbidden');
    try {
      return await fn(e, ...args);
    } catch (err) {
      // show the first validation message, not zod's JSON dump
      if (err instanceof z.ZodError) throw new Error(err.issues[0]?.message ?? '入力が不正です');
      throw err;
    }
  });
}

const reqIdOf = (v: unknown) => z.string().max(64).parse(v);

async function aiCall<T>(fn: () => Promise<T>): Promise<({ ok: true } & T) | { ok: false; error: string }> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    return { ok: false, error: ai.describeError(err) };
  }
}

function registerIpc() {
  handle('day:get', (_e, date) => {
    const d = assertDate(date);
    return { date: d, events: store.readDay(d), ai: store.readAi(d), live: d === dayKey(Date.now()) ? recorder.live() : null, liveCall: d === dayKey(Date.now()) ? recorder.liveCall() : null };
  });
  handle('days:list', () => store.summarizeDays());
  handle('status:get', () => status());
  handle('settings:get', () => store.getPublicSettings());
  handle('settings:set', async (_e, patch) => {
    // shortening the retention deletes days right away: say which, and let the user back out
    const days = (patch as Partial<Settings> | null)?.retentionDays;
    if (typeof days === 'number') {
      const doomed = store.expiredDays(days);
      if (doomed.length) {
        const { response } = await dialog.showMessageBox(mainWin!, {
          type: 'warning',
          buttons: ['削除して保存', 'キャンセル'],
          defaultId: 1,
          cancelId: 1,
          message: `保存期間を ${days} 日にすると、古い記録 ${doomed.length} 日分を削除します。`,
          detail: `対象: ${doomed[0]} 〜 ${doomed.at(-1)}
AI の作業ブロックと日報も含めて削除され、元に戻せません。`,
        });
        if (response !== 0) return { ...applySettings({ ...patch, retentionDays: store.getSettings().retentionDays }), retentionKept: true };
      }
    }
    return applySettings(patch);
  });
  handle('data:stats', () => store.stats());
  handle('settings:setSecret', async (_e, name, key) => {
    await store.setSecret(z.enum(['claude', 'local']).parse(name), key === null ? null : z.string().max(500).parse(key));
    broadcast('settings:changed', store.getPublicSettings());
    return store.getPublicSettings();
  });
  handle('settings:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWin!, { properties: ['openDirectory', 'multiSelections'], title: '記録するフォルダを選択' });
    if (res.canceled) return store.getPublicSettings();
    const tooBroad = res.filePaths.filter((p) => path.parse(p).root === p || p === app.getPath('home'));
    if (tooBroad.length) {
      await dialog.showMessageBox(mainWin!, { type: 'warning', message: 'ドライブ直下やホームフォルダ全体は登録できません。作業フォルダを選んでください。' });
      return store.getPublicSettings();
    }
    const folders = [...new Set([...store.getSettings().watchFolders, ...res.filePaths])];
    return applySettings({ watchFolders: folders });
  });
  handle('pause', (_e, minutes) => pause(z.union([z.number().int().min(1).max(1440), z.literal('today'), z.null()]).parse(minutes)));
  handle('memo:add', (_e, text) => recorder.addMemo(z.string().max(2000).parse(text)));
  handle('memo:hide', () => memoWin?.hide());
  handle('data:open', () => shell.openPath(store.dir));
  handle('day:delete', async (_e, date) => {
    const d = assertDate(date);
    const { response } = await dialog.showMessageBox(mainWin!, { type: 'warning', buttons: ['削除', 'キャンセル'], defaultId: 1, cancelId: 1, message: `${d} の記録と AI の結果をすべて削除します。元に戻せません。` });
    if (response !== 0) return false;
    store.deleteDay(d);
    broadcast('journal:changed', d);
    return true;
  });
  handle('event:delete', (_e, date, ev) => {
    const d = assertDate(date);
    store.deleteEvent(d, ev);
    broadcast('journal:changed', d);
  });
  handle('link:open', async (_e, url) => {
    const u = new URL(z.string().max(2000).parse(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
    const { response } = await dialog.showMessageBox(mainWin!, { type: 'question', buttons: ['開く', 'キャンセル'], defaultId: 1, cancelId: 1, message: '外部サイトをブラウザで開きますか？', detail: `${u.host}\n\n${u.href}` });
    if (response === 0) shell.openExternal(u.href);
  });
  handle('clipboard:write', (_e, text) => clipboard.writeText(z.string().max(200_000).parse(text)));

  handle('ai:preview', (_e, date) => ({ text: ai.preview(assertDate(date)), destination: ai.destination() }));
  handle('ai:cancel', (_e, reqId) => ai.cancel(reqIdOf(reqId)));
  handle('ai:save', (_e, date, patch) => store.writeAi(assertDate(date), AiPatch.parse(patch)));
  handle('ai:segment', (_e, date, reqId) => aiCall(async () => ({ ai: await ai.segment(assertDate(date), reqIdOf(reqId)) })));
  handle('ai:report', (e, date, reqId) => aiCall(async () => ({ ai: await ai.report(assertDate(date), reqIdOf(reqId), streamTo(e.sender, reqIdOf(reqId))) })));
  handle('ai:ask', (e, question, reqId, range) =>
    aiCall(async () => {
      const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
      const r = z.object({ from: date.optional(), to: date.optional() }).strict().parse(range ?? {});
      return { answer: await ai.ask(z.string().min(1).max(4000).parse(question), reqIdOf(reqId), streamTo(e.sender, reqIdOf(reqId)), r) };
    }),
  );
  handle('ai:resetChat', () => ai.resetChat());
  handle('local:models', (_e, baseUrl) =>
    aiCall(async () => ({ models: await LocalProvider.listModels(z.string().max(500).regex(/^https?:\/\/\S+$/i,'http(s) の URL を指定してください').parse(baseUrl), await store.getSecret('local')) })),
  );
}

// Rendered from build/*.svg by scripts/gen-icon.mjs (npm run gen:icon).
const iconDir = () => path.join(app.getAppPath(), 'resources', 'icons');
const appIcon = () => nativeImage.createFromPath(path.join(iconDir(), 'icon.png'));

/** Amber footprint while recording, slate while paused; one image per display scale. */
function trayIcon(paused: boolean) {
  const name = (size: number) => path.join(iconDir(), `tray-${paused ? 'paused-' : ''}${size}.png`);
  const img = nativeImage.createFromPath(name(16));
  for (const [size, scaleFactor] of [[20, 1.25], [24, 1.5], [32, 2]] as const) {
    img.addRepresentation({ scaleFactor, buffer: fs.readFileSync(name(size)) });
  }
  return img;
}

if (gotLock) {
  // No page of ours ever needs to leave file:// or open windows; links go through link:open.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (e, url) => {
      if (!url.startsWith(rendererUrl)) e.preventDefault();
    });
    contents.on('will-frame-navigate', (e) => {
      if (!e.url.startsWith(rendererUrl)) e.preventDefault();
    });
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  app.on('second-instance', showMain);
  app.on('before-quit', () => {
    quitting = true;
    recorder?.stop();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.quit());
  app.on('window-all-closed', () => {
    // stay resident in the tray
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('dev.ashiato.journal');
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');

    store = new Store();
    await store.init();
    store.purgeExpired();
    recorder = new Recorder(store);
    ai = new Ai(store, recorder);
    registerIpc();

    let pending: NodeJS.Timeout | undefined;
    const dates = new Set<string>();
    recorder.on('changed', (date: string) => {
      dates.add(date);
      pending ??= setTimeout(() => {
        for (const d of dates) broadcast('journal:changed', d);
        dates.clear();
        pending = undefined;
      }, 1500);
    });
    if (store.getSettings().onboarded) recorder.start();

    tray = new Tray(trayIcon(store.getSettings().paused));
    tray.on('click', showMain);
    refreshTray();

    // housekeeping: timed pauses, retention, status for the header
    setInterval(() => {
      const s = store.getSettings();
      if (s.paused && s.pausedUntil && Date.now() >= s.pausedUntil) pause(null);
      broadcast('status:changed', status());
    }, 15_000);
    setInterval(() => store.purgeExpired(), 6 * 3600_000);

    shortcutOk = globalShortcut.register(MEMO_SHORTCUT, toggleMemo);
    createMainWindow();
  });

  // onboarding finished from the renderer: start recording for the first time
  ipcMain.on('onboarded', (e) => {
    if (!e.senderFrame?.url.startsWith(rendererUrl)) return;
    applySettings({ onboarded: true });
    recorder.start();
  });
}
