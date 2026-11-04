import { BrowserWindow, Menu, Tray, app, dialog, globalShortcut, ipcMain, nativeImage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Settings, StreamEvent, dayKey } from '../shared/types';
import { Ai, describeError } from './ai';
import { Recorder } from './recorder';
import { Store } from './store';

const MEMO_SHORTCUT = 'CommandOrControl+Alt+J';

// separate profile for development / trying things out without touching the real journal
if (process.env.ASHIATO_USER_DATA) app.setPath('userData', path.resolve(process.env.ASHIATO_USER_DATA));
if (!app.requestSingleInstanceLock()) app.quit();

let store: Store;
let recorder: Recorder;
let ai: Ai;
let mainWin: BrowserWindow | null = null;
let memoWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const rendererDir = path.join(__dirname, 'renderer');
const preload = path.join(__dirname, 'preload.js');

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: '足跡ジャーナル',
    icon: makeIcon(64),
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWin.loadFile(path.join(rendererDir, 'index.html'));
  mainWin.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) mainWin?.show();
    const shot = process.env.ASHIATO_SNAPSHOT;
    if (shot) {
      setTimeout(async () => {
        const img = await mainWin!.webContents.capturePage();
        fs.writeFileSync(shot, img.toPNG());
      }, Number(process.env.ASHIATO_SNAPSHOT_DELAY ?? 4000));
    }
  });
  mainWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWin?.hide();
    }
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showMain() {
  if (!mainWin) createMainWindow();
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
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  memoWin.loadFile(path.join(rendererDir, 'memo.html'));
  memoWin.once('ready-to-show', () => {
    memoWin?.show();
    memoWin?.focus();
  });
  memoWin.on('blur', () => memoWin?.hide());
}

function refreshTray() {
  if (!tray) return;
  const paused = store.getSettings().paused;
  tray.setToolTip(paused ? '足跡ジャーナル（一時停止中）' : '足跡ジャーナル（記録中）');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '開く', click: showMain },
      { label: `クイックメモ (${MEMO_SHORTCUT.replace('CommandOrControl', 'Ctrl')})`, click: toggleMemo },
      { type: 'separator' },
      { label: paused ? '記録を再開' : '記録を一時停止', click: () => applySettings({ paused: !paused }) },
      { type: 'separator' },
      { label: '終了', click: () => app.quit() },
    ]),
  );
}

function applySettings(patch: Partial<Settings>) {
  const prev = store.getSettings();
  const next = store.updateSettings(patch);
  if (patch.openAtLogin !== undefined && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: next.openAtLogin, args: ['--hidden'] });
  }
  recorder.reconfigure(prev.pollSeconds);
  refreshTray();
  broadcast('settings:changed', store.getPublicSettings());
  return store.getPublicSettings();
}

function broadcast(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

function streamTo(sender: Electron.WebContents, reqId: string) {
  return (kind: StreamEvent['kind'], data: string) => {
    if (!sender.isDestroyed()) sender.send('ai:stream', { reqId, kind, data } satisfies StreamEvent);
  };
}

function registerIpc() {
  ipcMain.handle('day:get', (_e, date: string) => ({
    date,
    events: store.readDay(date),
    ai: store.readAi(date),
    live: date === dayKey(Date.now()) ? recorder.live() : null,
  }));
  ipcMain.handle('days:list', () => store.summarizeDays());
  ipcMain.handle('settings:get', () => store.getPublicSettings());
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => applySettings(patch));
  ipcMain.handle('settings:setApiKey', (_e, key: string | null) => {
    store.setApiKey(key);
    broadcast('settings:changed', store.getPublicSettings());
    return store.getPublicSettings();
  });
  ipcMain.handle('settings:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWin!, { properties: ['openDirectory', 'multiSelections'], title: '記録するフォルダを選択' });
    if (res.canceled) return store.getPublicSettings();
    const folders = [...new Set([...store.getSettings().watchFolders, ...res.filePaths])];
    return applySettings({ watchFolders: folders });
  });
  ipcMain.handle('memo:add', (_e, text: string) => recorder.addMemo(text));
  ipcMain.handle('memo:hide', () => memoWin?.hide());
  ipcMain.handle('data:open', () => shell.openPath(store.dir));

  ipcMain.handle('ai:preview', (_e, date: string) => ai.preview(date));
  ipcMain.handle('ai:segment', async (_e, date: string) => {
    try {
      return { ok: true, ai: await ai.segment(date) };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  });
  ipcMain.handle('ai:report', async (e, date: string, reqId: string) => {
    const emit = streamTo(e.sender, reqId);
    try {
      const res = await ai.report(date, emit);
      emit('done', res.report ?? '');
      return { ok: true, ai: res };
    } catch (err) {
      emit('error', describeError(err));
      return { ok: false, error: describeError(err) };
    }
  });
  ipcMain.handle('ai:ask', async (e, question: string, reqId: string) => {
    const emit = streamTo(e.sender, reqId);
    try {
      const answer = await ai.ask(question, emit);
      emit('done', answer);
      return { ok: true, answer };
    } catch (err) {
      emit('error', describeError(err));
      return { ok: false, error: describeError(err) };
    }
  });
  ipcMain.handle('ai:resetChat', () => ai.resetChat());
}

/** A small footprint glyph drawn into a BGRA bitmap, so the app ships without image assets. */
function makeIcon(size: number) {
  const buf = Buffer.alloc(size * size * 4);
  const dots: [number, number, number][] = [
    [0.5, 0.62, 0.26], // sole
    [0.3, 0.3, 0.09],
    [0.45, 0.22, 0.09],
    [0.6, 0.22, 0.09],
    [0.74, 0.3, 0.09],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      let a = 0;
      for (const [cx, cy, r] of dots) {
        const ry = cx === 0.5 && cy === 0.62 ? r * 1.25 : r;
        const d = Math.hypot((u - cx) / r, (v - cy) / ry);
        a = Math.max(a, Math.min(1, Math.max(0, (1 - d) * size * r * 0.9)));
      }
      const i = (y * size + x) * 4;
      buf[i] = 0x7a; // B
      buf[i + 1] = 0xc9; // G
      buf[i + 2] = 0xf5; // R
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

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

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('dev.ashiato.journal');
  store = new Store();
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
  recorder.start();

  tray = new Tray(makeIcon(process.platform === 'darwin' ? 18 : 16));
  tray.on('click', showMain);
  refreshTray();

  if (!globalShortcut.register(MEMO_SHORTCUT, toggleMemo)) console.warn('shortcut already taken:', MEMO_SHORTCUT);
  createMainWindow();
});
