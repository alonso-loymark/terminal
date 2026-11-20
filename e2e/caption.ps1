param(
  [Parameter(Mandatory)][ValidateSet('probe', 'press', 'leave', 'click', 'zoomed', 'restore')][string]$Action,
  [Parameter(Mandatory)][int]$ProcessId,
  [ValidateSet('minimize', 'maximize', 'close')][string]$Button = 'maximize'
)
# The custom title bar's caption buttons, through Win32 messages to the native overlay
# (src-tauri/src/titlebar.rs): what Windows asks it (WM_NCHITTEST, which is what makes Snap
# Layouts appear) and what the mouse would send. Never moves the real mouse nor captures the
# screen. Targets one process id. Prints JSON.
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class E2ECaption {
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  // The process's visible top-level window that hosts the WebView (Process.MainWindowHandle may
  // pick tao's hidden event window instead).
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
# Physical pixels, like the app (per-monitor aware): a DPI-unaware process sees virtualized
# coordinates (at 150 %, a 207 px wide window measures 138).
[E2ECaption]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$main = [E2ECaption]::AppWindow([uint32]$ProcessId)
if ($main -eq [IntPtr]::Zero) { throw "process $ProcessId has no app window" }
$overlay = [E2ECaption]::FindWindowEx($main, [IntPtr]::Zero, 'BrisaCaptionButtons', $null)
$codes = @{ minimize = 8; maximize = 9; close = 20 }
$index = @{ minimize = 0; maximize = 1; close = 2 }

function Point-Of([string]$name) {
  $r = New-Object E2ECaption+RECT
  [E2ECaption]::GetWindowRect($overlay, [ref]$r) | Out-Null
  $third = ($r.Right - $r.Left) / 3
  $x = [int]($r.Left + $third * $index[$name] + $third / 2)
  $y = [int](($r.Top + $r.Bottom) / 2)
  # MAKELPARAM with signed 16-bit halves (multi-monitor coordinates can be negative).
  return [IntPtr](($y -band 0xffff) -shl 16 -bor ($x -band 0xffff))
}

switch ($Action) {
  'probe' {
    # Windows' own title bar: the client area starts well below the window's top edge. (Not the
    # WS_CAPTION style: tao keeps it on undecorated windows, for the shadow.)
    $wr = New-Object E2ECaption+RECT
    [E2ECaption]::GetWindowRect($main, [ref]$wr) | Out-Null
    $origin = New-Object E2ECaption+POINT
    [E2ECaption]::ClientToScreen($main, [ref]$origin) | Out-Null
    $caption = ($origin.Y - $wr.Top) -gt 12
    if ($overlay -eq [IntPtr]::Zero) { @{ overlay = $false; nativeTitleBar = $caption } | ConvertTo-Json -Compress; break }
    $r = New-Object E2ECaption+RECT
    [E2ECaption]::GetWindowRect($overlay, [ref]$r) | Out-Null
    $hits = @{}
    foreach ($name in 'minimize', 'maximize', 'close') {
      # WM_NCHITTEST
      $hits[$name] = [int][E2ECaption]::SendMessage($overlay, 0x0084, [IntPtr]::Zero, (Point-Of $name))
    }
    # GWL_EXSTYLE: WS_EX_LAYERED (0x80000) | WS_EX_NOREDIRECTIONBITMAP (0x200000)
    $ex = [E2ECaption]::GetWindowLong($overlay, -20)
    @{ overlay = $true; nativeTitleBar = $caption; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top; hits = $hits; layered = (($ex -band 0x80000) -ne 0); noRedirection = (($ex -band 0x200000) -ne 0) } | ConvertTo-Json -Compress
  }
  # WM_NCLBUTTONDOWN only: the button shows as pressed until 'leave' or a release. (A synthetic
  # WM_NCMOUSEMOVE cannot show hover: TrackMouseEvent sees the real cursor elsewhere and sends
  # WM_NCMOUSELEAVE at once.)
  'press' { [E2ECaption]::SendMessage($overlay, 0x00A1, [IntPtr]$codes[$Button], (Point-Of $Button)) | Out-Null; '{}' }
  # WM_NCMOUSELEAVE
  'leave' { [E2ECaption]::SendMessage($overlay, 0x02A2, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; '{}' }
  # WM_NCLBUTTONDOWN + WM_NCLBUTTONUP
  'click' {
    $at = Point-Of $Button
    [E2ECaption]::SendMessage($overlay, 0x00A1, [IntPtr]$codes[$Button], $at) | Out-Null
    [E2ECaption]::SendMessage($overlay, 0x00A2, [IntPtr]$codes[$Button], $at) | Out-Null
    '{}'
  }
  'zoomed' { @{ zoomed = [E2ECaption]::IsZoomed($main) } | ConvertTo-Json -Compress }
  # SW_RESTORE
  'restore' { [E2ECaption]::ShowWindow($main, 9) | Out-Null; '{}' }
}
