import { ChildProcess, execFile, spawn } from 'node:child_process';
import path from 'node:path';

export interface WindowSample {
  app: string;
  title: string;
}

// One long-lived PowerShell process polls the foreground window and prints a JSON line per tick,
// so there is no native addon to rebuild for each Electron version. The script goes in over stdin
// (no -EncodedCommand / -ExecutionPolicy Bypass, which endpoint security tools flag).
const WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AshiatoWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $h = [AshiatoWin]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 1024
  [void][AshiatoWin]::GetWindowText($h, $sb, 1024)
  [uint32]$procId = 0
  [void][AshiatoWin]::GetWindowThreadProcessId($h, [ref]$procId)
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  $name = if ($p) { $p.ProcessName } else { '' }
  $json = @{ app = $name; title = $sb.ToString() } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($json)
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
          this.onSample({ app: s.app ?? '', title: s.title ?? '' });
        } catch {
          // ignore partial output
        }
      }
    });
    proc.stdin.end(WIN_SCRIPT.replace('__INTERVAL__', String(this.intervalMs)) + '\n');
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
