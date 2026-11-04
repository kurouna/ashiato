import { contextBridge, ipcRenderer } from 'electron';
import type { DayAi, DayData, DaySummary, JournalEvent, PublicSettings, SecretName, Settings, Status, StreamEvent, WorkBlock } from './shared/types';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const api = {
  getDay: (date: string): Promise<DayData> => ipcRenderer.invoke('day:get', date),
  listDays: (): Promise<DaySummary[]> => ipcRenderer.invoke('days:list'),
  deleteDay: (date: string): Promise<boolean> => ipcRenderer.invoke('day:delete', date),
  deleteEvent: (date: string, ev: JournalEvent): Promise<void> => ipcRenderer.invoke('event:delete', date, ev),
  getStatus: (): Promise<Status> => ipcRenderer.invoke('status:get'),
  getSettings: (): Promise<PublicSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<PublicSettings> => ipcRenderer.invoke('settings:set', patch),
  setSecret: (name: SecretName, key: string | null): Promise<PublicSettings> => ipcRenderer.invoke('settings:setSecret', name, key),
  pickFolder: (): Promise<PublicSettings> => ipcRenderer.invoke('settings:pickFolder'),
  pause: (minutes: number | 'today' | null): Promise<PublicSettings> => ipcRenderer.invoke('pause', minutes),
  finishOnboarding: () => ipcRenderer.send('onboarded'),
  addMemo: (text: string): Promise<void> => ipcRenderer.invoke('memo:add', text),
  hideMemo: (): Promise<void> => ipcRenderer.invoke('memo:hide'),
  openData: (): Promise<void> => ipcRenderer.invoke('data:open'),
  openLink: (url: string): Promise<void> => ipcRenderer.invoke('link:open', url),
  copy: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  preview: (date: string): Promise<{ text: string; destination: string }> => ipcRenderer.invoke('ai:preview', date),
  segment: (date: string): Promise<Result<{ ai: DayAi }>> => ipcRenderer.invoke('ai:segment', date),
  report: (date: string, reqId: string): Promise<Result<{ ai: DayAi }>> => ipcRenderer.invoke('ai:report', date, reqId),
  ask: (question: string, reqId: string): Promise<Result<{ answer: string }>> => ipcRenderer.invoke('ai:ask', question, reqId),
  cancel: (reqId: string): Promise<void> => ipcRenderer.invoke('ai:cancel', reqId),
  saveAi: (date: string, patch: { report?: string; blocks?: WorkBlock[] }): Promise<DayAi> => ipcRenderer.invoke('ai:save', date, patch),
  resetChat: (): Promise<void> => ipcRenderer.invoke('ai:resetChat'),
  listLocalModels: (baseUrl: string): Promise<Result<{ models: string[] }>> => ipcRenderer.invoke('local:models', baseUrl),
  onStream: (cb: (e: StreamEvent) => void) => {
    ipcRenderer.on('ai:stream', (_: unknown, e: StreamEvent) => cb(e));
  },
  onJournalChanged: (cb: (date: string) => void) => {
    ipcRenderer.on('journal:changed', (_: unknown, d: string) => cb(d));
  },
  onSettingsChanged: (cb: (s: PublicSettings) => void) => {
    ipcRenderer.on('settings:changed', (_: unknown, s: PublicSettings) => cb(s));
  },
  onStatus: (cb: (s: Status) => void) => {
    ipcRenderer.on('status:changed', (_: unknown, s: Status) => cb(s));
  },
};

export type AshiatoApi = typeof api;
contextBridge.exposeInMainWorld('ashiato', api);
