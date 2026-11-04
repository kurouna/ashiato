import { contextBridge, ipcRenderer } from 'electron';
import type { DayAi, DayData, DaySummary, PublicSettings, Settings, StreamEvent } from './shared/types';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const api = {
  getDay: (date: string): Promise<DayData> => ipcRenderer.invoke('day:get', date),
  listDays: (): Promise<DaySummary[]> => ipcRenderer.invoke('days:list'),
  getSettings: (): Promise<PublicSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<PublicSettings> => ipcRenderer.invoke('settings:set', patch),
  setApiKey: (key: string | null): Promise<PublicSettings> => ipcRenderer.invoke('settings:setApiKey', key),
  pickFolder: (): Promise<PublicSettings> => ipcRenderer.invoke('settings:pickFolder'),
  addMemo: (text: string): Promise<void> => ipcRenderer.invoke('memo:add', text),
  hideMemo: (): Promise<void> => ipcRenderer.invoke('memo:hide'),
  openData: (): Promise<void> => ipcRenderer.invoke('data:open'),
  preview: (date: string): Promise<string> => ipcRenderer.invoke('ai:preview', date),
  segment: (date: string): Promise<Result<{ ai: DayAi }>> => ipcRenderer.invoke('ai:segment', date),
  report: (date: string, reqId: string): Promise<Result<{ ai: DayAi }>> => ipcRenderer.invoke('ai:report', date, reqId),
  ask: (question: string, reqId: string): Promise<Result<{ answer: string }>> => ipcRenderer.invoke('ai:ask', question, reqId),
  resetChat: (): Promise<void> => ipcRenderer.invoke('ai:resetChat'),
  onStream: (cb: (e: StreamEvent) => void) => {
    const fn = (_: unknown, e: StreamEvent) => cb(e);
    ipcRenderer.on('ai:stream', fn);
    return () => ipcRenderer.removeListener('ai:stream', fn);
  },
  onJournalChanged: (cb: (date: string) => void) => {
    ipcRenderer.on('journal:changed', (_: unknown, d: string) => cb(d));
  },
  onSettingsChanged: (cb: (s: PublicSettings) => void) => {
    ipcRenderer.on('settings:changed', (_: unknown, s: PublicSettings) => cb(s));
  },
};

export type AshiatoApi = typeof api;
contextBridge.exposeInMainWorld('ashiato', api);
