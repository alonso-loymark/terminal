param(
  [Parameter(Mandatory)][ValidateSet('resize', 'close')][string]$Action,
  [Parameter(Mandatory)][int]$ProcessId,
  [int]$Width = 0,
  [int]$Height = 0
)
# Drives the app window with real Win32 calls. Targets one process id, never "any terminal.exe".
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class E2EWindow {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
$p = Get-Process -Id $ProcessId
if ($p.MainWindowHandle -eq 0) { throw "process $ProcessId has no main window" }
switch ($Action) {
  # SWP_NOMOVE | SWP_NOZORDER
  'resize' { [E2EWindow]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, 0, 0, $Width, $Height, 0x0006) | Out-Null }
  'close'  { $p.CloseMainWindow() | Out-Null }
}
