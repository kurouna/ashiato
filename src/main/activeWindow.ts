import { ChildProcess, execFile, spawn } from 'node:child_process';
import path from 'node:path';

export interface WindowSample {
  app: string;
  title: string;
  /** Apps holding the microphone right now (Windows privacy registry). Only on "call check" ticks. */
  mic?: string[];
  /** Titles of open windows that look like a meeting (Zoom / Meet / Webex …), foreground or not. */
  meetings?: string[];
}

/** Window titles that only exist while in a meeting. Teams is detected through the microphone instead. */
export const MEETING_TITLE = String.raw`Zoom (Meeting|Webinar)|Zoom ミーティング|Zoom ウェビナー|^Meet - [a-z]{3}-[a-z]{4}-[a-z]{3}|Google Meet|Webex|Slack.*(ハドル|[Hh]uddle)`;

// One long-lived PowerShell process polls the foreground window and prints a JSON line per tick,
// so there is no native addon to rebuild for each Electron version. The script goes in over stdin
// (no -EncodedCommand / -ExecutionPolicy Bypass, which endpoint security tools flag).
// Every few ticks it also checks for an ongoing call: which apps hold the microphone (read from the
// same registry the Windows privacy indicator uses; no audio is touched) and which windows look like a meeting.
const WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AshiatoWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public static string[] VisibleTitles() {
    var list = new List<string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (IsWindowVisible(h)) {
        int n = GetWindowTextLength(h);
        if (n > 0) { var sb = new StringBuilder(n + 1); GetWindowText(h, sb, n + 1); list.Add(sb.ToString()); }
      }
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
}
"@
$micBase = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
function Get-MicApps {
  $apps = @()
  foreach ($k in @(Get-ChildItem $micBase -ErrorAction SilentlyContinue)) {
    $keys = if ($k.PSChildName -eq 'NonPackaged') { @(Get-ChildItem $k.PSPath -ErrorAction SilentlyContinue) } else { @($k) }
    foreach ($e in $keys) {
      $p = Get-ItemProperty $e.PSPath -ErrorAction SilentlyContinue
      # LastUsedTimeStop stays 0 while the app is still using the microphone
      if ($p -and $p.LastUsedTimeStart -gt 0 -and $p.LastUsedTimeStop -eq 0) { $apps += ($e.PSChildName -split '#')[-1] }
    }
  }
  ,$apps
}
$meetRe = [regex]'__MEETING__'
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
$tick = 0
while ($true) {
  $h = [AshiatoWin]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 1024
  [void][AshiatoWin]::GetWindowText($h, $sb, 1024)
  [uint32]$procId = 0
  [void][AshiatoWin]::GetWindowThreadProcessId($h, [ref]$procId)
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  $name = if ($p) { $p.ProcessName } else { '' }
  $out = @{ app = $name; title = $sb.ToString() }
  if (__CALLS__ -and ($tick % 3) -eq 0) {
    try { $out.mic = Get-MicApps } catch { $out.mic = @() }
    $out.meetings = @([AshiatoWin]::VisibleTitles() | Where-Object { $meetRe.IsMatch($_) } | Select-Object -First 3)
  }
  $tick++
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds __INTERVAL__
}
`;

const MAC_SCRIPT = [
  'tell application "System Events"',
  'set p to first application process whose frontmost is true',
  'set n to name of p',
  'set t to ""',
  'try',
  'set t to name of front window of p',
  'end try',
  'end tell',
  'return n & tab & t',
];

export type ProbeState = { ok: true } | { ok: false; reason: string };

export class ActiveWindowProbe {
  private proc?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private stopped = true;
  private failures = 0;
  state: ProbeState = { ok: false, reason: '起動中' };

  constructor(
    private intervalMs: number,
    private onSample: (s: WindowSample | null) => void,
    private detectCalls = true,
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (process.platform === 'win32') this.startWindows();
    else this.startPolling();
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
    this.proc = undefined;
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = this.retry = undefined;
  }

  private startWindows() {
    const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const proc = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    let buf = '';
    let stderr = '';
    proc.on('error', (err) => (stderr += String(err)));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d: string) => (stderr = (stderr + d).slice(-2000)));
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'READY') {
          this.failures = 0;
          this.state = { ok: true };
          continue;
        }
        if (!line.startsWith('{')) continue;
        try {
          const s = JSON.parse(line) as WindowSample;
          this.onSample({ app: s.app ?? '', title: s.title ?? '', mic: asList(s.mic), meetings: asList(s.meetings) });
        } catch {
          // ignore partial output
        }
      }
    });
    const script = WIN_SCRIPT.replace('__INTERVAL__', String(this.intervalMs))
      .replace('__CALLS__', this.detectCalls ? '$true' : '$false')
      .replace('__MEETING__', MEETING_TITLE.replace(/'/g, "''"));
    proc.stdin.end(script + '\n');
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      if (this.stopped) return;
      this.failures++;
      const blocked = /Add-Type|ConstrainedLanguage|言語モード|language mode/i.test(stderr);
      this.state = {
        ok: false,
        reason: blocked
          ? 'PowerShell の制限（制約付き言語モード等）でウィンドウ情報を取得できません。社内ポリシーをご確認ください。'
          : `ウィンドウ情報の取得プロセスが停止しました${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`,
      };
      // back off: 5s, 10s, 20s … up to 5 minutes
      const wait = Math.min(300_000, 5000 * 2 ** Math.min(this.failures - 1, 6));
      this.retry = setTimeout(() => !this.stopped && this.startWindows(), wait);
    });
  }

  private startPolling() {
    const tick = () => {
      if (process.platform === 'darwin') {
        execFile('/usr/bin/osascript', MAC_SCRIPT.flatMap((l) => ['-e', l]), { timeout: 3000 }, (err, out) => {
          if (err) {
            this.state = { ok: false, reason: 'macOS の「オートメーション」「アクセシビリティ」許可が必要です' };
            return this.onSample(null);
          }
          this.state = { ok: true };
          const [app, ...rest] = out.trim().split('\t');
          this.onSample({ app, title: rest.join('\t') });
        });
      } else {
        execFile('xdotool', ['getactivewindow', 'getwindowname'], { timeout: 3000 }, (err, out) => {
          if (err) {
            this.state = { ok: false, reason: 'xdotool が見つからないか、Wayland セッションのため取得できません' };
            return this.onSample(null);
          }
          this.state = { ok: true };
          this.onSample({ app: '', title: out.trim() });
        });
      }
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }
}

/** ConvertTo-Json turns a one-element array into a bare string and an empty one into null. */
function asList(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (v === null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** "MSTeams_8wekyb3d8bbwe" / "ms-teams.exe" / "Zoom.exe" → a short app name for the journal. */
export function micAppName(raw: string): string {
  const base = raw.replace(/.exe$/i, '').replace(/_[a-z0-9]{13}$/i, '');
  const known: [RegExp, string][] = [
    [/teams/i, 'Teams'],
    [/zoom/i, 'Zoom'],
    [/webex|ciscocollab/i, 'Webex'],
    [/slack/i, 'Slack'],
    [/discord/i, 'Discord'],
    [/chrome/i, 'Chrome'],
    [/msedge/i, 'Edge'],
    [/firefox/i, 'Firefox'],
  ];
  return known.find(([re]) => re.test(base))?.[1] ?? base;
}
