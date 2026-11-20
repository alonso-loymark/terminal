param(
  [Parameter(Mandatory)][ValidateSet('resize', 'close')][string]$Action,
  [Parameter(Mandatory)][int]$ProcessId,
  [int]$Width = 0,
  [int]$Height = 0
)
# Drives the app window with real Win32 calls. Targets one process id, never "any brisa.exe".
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class E2EWindow {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  // The process's visible top-level window that hosts the WebView. Process.MainWindowHandle may
  // pick tao's hidden event window instead (seen with the custom title bar).
  public static IntPtr AppWindow(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner == pid && IsWindowVisible(h) && FindWindowEx(h, IntPtr.Zero, "WRY_WEBVIEW", null) != IntPtr.Zero) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$window = [E2EWindow]::AppWindow([uint32]$ProcessId)
if ($window -eq [IntPtr]::Zero) { throw "process $ProcessId has no app window" }
switch ($Action) {
  # SWP_NOMOVE | SWP_NOZORDER
  'resize' { [E2EWindow]::SetWindowPos($window, [IntPtr]::Zero, 0, 0, $Width, $Height, 0x0006) | Out-Null }
  # WM_CLOSE, like the window's close button
  'close'  { [E2EWindow]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
}
