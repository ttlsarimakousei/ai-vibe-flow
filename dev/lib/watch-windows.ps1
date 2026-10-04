# Watches the desktop while tests run: logs every top-level visible window that appears after start,
# even if it closes right away. ASCII only (Windows PowerShell 5.1 reads a BOM-less file as ANSI).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File watch-windows.ps1 -Out <log file> -Stop <stop file>
# The log starts with READY, then one line per new window: NEW <tab> process <tab> pid <tab> class <tab> title. Ends with DONE.
param([string]$Out, [string]$Stop, [int]$IntervalMs = 120, [int]$MaxSeconds = 3600)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class VkWinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static List<string> List() {
    var res = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      res.Add(h.ToInt64() + "\t" + pid + "\t" + c.ToString() + "\t" + t.ToString().Replace("\t", " ").Replace("\r", " ").Replace("\n", " "));
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@
$utf8 = New-Object System.Text.UTF8Encoding($false)
$seen = @{}
foreach ($w in [VkWinEnum]::List()) { $seen[($w -split "`t")[0]] = 1 }
[System.IO.File]::AppendAllText($Out, "READY`n", $utf8)
$end = (Get-Date).AddSeconds($MaxSeconds)
while ((Get-Date) -lt $end -and -not (Test-Path -LiteralPath $Stop)) {
  foreach ($w in [VkWinEnum]::List()) {
    $p = $w -split "`t"
    if (-not $seen.ContainsKey($p[0])) {
      $seen[$p[0]] = 1
      $name = ""
      try { $name = (Get-Process -Id ([int]$p[1]) -ErrorAction Stop).ProcessName } catch {}
      [System.IO.File]::AppendAllText($Out, ("NEW`t" + $name + "`t" + $p[1] + "`t" + $p[2] + "`t" + $p[3] + "`n"), $utf8)
    }
  }
  Start-Sleep -Milliseconds $IntervalMs
}
[System.IO.File]::AppendAllText($Out, "DONE`n", $utf8)
