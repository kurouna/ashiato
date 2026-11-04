import { ChildProcess, execFile, spawn } from 'node:child_process';

export interface WindowSample {
  app: string;
  title: string;
}

// One long-lived PowerShell process polls the foreground window and prints a JSON line per tick,
// so there is no native addon to rebuild for each Electron version.
const WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
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
$names = @{}
while ($true) {
  $h = [AshiatoWin]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 1024
  [void][AshiatoWin]::GetWindowText($h, $sb, 1024)
  [uint32]$procId = 0
  [void][AshiatoWin]::GetWindowThreadProcessId($h, [ref]$procId)
  if (-not $names.ContainsKey($procId)) {
    $p = Get-Process -Id $procId
    $names[$procId] = if ($p) { $p.ProcessName } else { '' }
  }
  $json = @{ app = $names[$procId]; title = $sb.ToString() } | ConvertTo-Json -Compress
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

export class ActiveWindowProbe {
  private proc?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private stopped = true;

  constructor(
    private intervalMs: number,
    private onSample: (s: WindowSample | null) => void,
  ) {}

  start() {
    this.stopped = false;
    if (process.platform === 'win32') this.startWindows();
    else this.startPolling();
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
    this.proc = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private startWindows() {
    const script = WIN_SCRIPT.replace('__INTERVAL__', String(this.intervalMs));
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
    });
    this.proc = proc;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const s = JSON.parse(line) as WindowSample;
          this.onSample({ app: s.app ?? '', title: s.title ?? '' });
        } catch {
          // ignore partial output
        }
      }
    });
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = undefined;
      if (!this.stopped) setTimeout(() => !this.stopped && !this.proc && this.startWindows(), 5000);
    });
  }

  private startPolling() {
    const tick = () => {
      if (process.platform === 'darwin') {
        execFile('osascript', MAC_SCRIPT.flatMap((l) => ['-e', l]), { timeout: 3000 }, (err, out) => {
          if (err) return this.onSample(null);
          const [app, ...rest] = out.trim().split('\t');
          this.onSample({ app, title: rest.join('\t') });
        });
      } else {
        execFile('xdotool', ['getactivewindow', 'getwindowname'], { timeout: 3000 }, (err, out) => {
          if (err) return this.onSample(null);
          this.onSample({ app: '', title: out.trim() });
        });
      }
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }
}
