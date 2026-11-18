# Shell integration for Windows PowerShell 5.1 and PowerShell 7+.
#
# The terminal starts PowerShell with
#     -NoExit -Command "try { . '<this file>' } catch { <report the error> }"
# so the user's profile has already run when this file loads: whatever prompt it defined
# (oh-my-posh, starship, a custom one) is wrapped, never replaced. The profile itself is not
# touched.
#
# Sequences written to the terminal:
#     OSC 7   ; file://<host>/<path>    current directory, path percent-encoded as UTF-8
#     OSC 133 ; A                       prompt starts
#     OSC 133 ; B                       prompt ends, the user types the command
#     OSC 133 ; C                       the command starts running (output follows)
#     OSC 133 ; D [; <exit code>]       the command finished
#     OSC 633 ; E ; <command line>      the command about to run (VS Code escaping)
#     OSC 633 ; P ; Shell=powershell    the integration is loaded
# If this file cannot load (an execution policy that forbids it, an error), the launcher's
# catch writes OSC 633 ; P ; IntegrationError=<message> instead and the shell works as usual.
#
# Windows PowerShell 5.1 has no `e escape: [char]27 and [char]7 are used throughout.
#
# The body runs in a child scope with strict mode off (a profile may enable it, and strict mode
# is per scope), so nothing here changes the user's own settings. Everything that must outlive
# it is explicitly global.

& {
Set-StrictMode -Off
if (Get-Variable -Name __TerminalShellIntegration -Scope Global -ErrorAction SilentlyContinue) { return }

$global:__TerminalShellIntegration = @{
    Esc            = [string][char]27
    Bel            = [string][char]7
    OriginalPrompt = $function:prompt
    # Wrapped lazily (see __Terminal-EnsureHooks): PSReadLine may load after this file.
    OriginalReadLine = $null
    CommandRunning = $false
    ExitCodeBefore = $global:LASTEXITCODE
    LastHistoryId  = -1
}

function global:__Terminal-Write([string]$Payload) {
    $s = $global:__TerminalShellIntegration
    [Console]::Write($s.Esc + ']' + $Payload + $s.Bel)
}

# VS Code's OSC 633 escaping: backslash, semicolon and control characters as \xHH.
function global:__Terminal-Escape([string]$Value) {
    $builder = New-Object System.Text.StringBuilder
    foreach ($c in $Value.ToCharArray()) {
        $code = [int]$c
        if ($c -eq '\') { [void]$builder.Append('\\') }
        elseif ($c -eq ';') { [void]$builder.Append('\x3b') }
        elseif ($code -lt 32 -or $code -eq 127) { [void]$builder.Append(('\x{0:x2}' -f $code)) }
        else { [void]$builder.Append($c) }
    }
    $builder.ToString()
}

# file://<host>/<path> for the current FileSystem location; $null elsewhere (Registry, Env:...).
function global:__Terminal-CwdUri {
    $location = $ExecutionContext.SessionState.Path.CurrentLocation
    if ($location.Provider.Name -ne 'FileSystem') { return $null }
    $path = $location.ProviderPath
    if ($path.StartsWith('\\?\')) { $path = $path.Substring(4) }
    if ($path.StartsWith('\\')) {
        # UNC: \\server\share\dir -> file://server/share/dir
        $parts = $path.Substring(2).Split('\')
        $hostName = $parts[0]
        $segments = @($parts | Select-Object -Skip 1)
    } else {
        $hostName = $env:COMPUTERNAME
        $segments = $path.Split('\')
    }
    $encoded = foreach ($segment in $segments) {
        # Keep the drive (C:) readable; everything else is percent-encoded UTF-8.
        if ($segment -match '^[A-Za-z]:$') { $segment } else { [Uri]::EscapeDataString($segment) }
    }
    'file://' + $hostName + '/' + ($encoded -join '/')
}

# Re-installs the hooks when something replaced them (the user redefining prompt, PSReadLine
# loading after this file). Cheap: a string check per prompt.
function global:__Terminal-EnsureHooks {
    $s = $global:__TerminalShellIntegration
    $readLine = $function:PSConsoleHostReadLine
    if ($readLine -and $readLine.ToString() -notmatch '__TerminalShellIntegration') {
        $s.OriginalReadLine = $readLine
        $function:global:PSConsoleHostReadLine = $global:__TerminalReadLineHook
    }
    $prompt = $function:prompt
    if ($prompt -and $prompt.ToString() -notmatch '__TerminalShellIntegration') {
        $s.OriginalPrompt = $prompt
        $function:global:prompt = $global:__TerminalPromptHook
        return $true
    }
    return $false
}

$global:__TerminalPromptHook = {
    # __TerminalShellIntegration (marker: this prompt is ours)
    $success = $global:?
    Set-StrictMode -Off
    $nativeExit = $global:LASTEXITCODE
    $s = $global:__TerminalShellIntegration
    $sequence = ''

    if (-not $s.OriginalReadLine) {
        # Without PSReadLine there is no hook before a command runs: report it afterwards from
        # the history, so the command line and its exit code are still known.
        $entry = Get-History -Count 1
        if ($entry -and $entry.Id -ne $s.LastHistoryId) {
            $s.LastHistoryId = $entry.Id
            $sequence += $s.Esc + ']633;E;' + (__Terminal-Escape $entry.CommandLine) + $s.Bel + $s.Esc + ']133;C' + $s.Bel
            $s.CommandRunning = $true
        }
    }
    if ($s.CommandRunning) {
        if ($success) { $code = 0 }
        elseif ($nativeExit -is [int] -and $nativeExit -ne 0 -and $nativeExit -ne $s.ExitCodeBefore) { $code = $nativeExit }
        else { $code = 1 }
        $sequence += $s.Esc + ']133;D;' + $code + $s.Bel
        $s.CommandRunning = $false
    }
    $uri = __Terminal-CwdUri
    if ($uri) { $sequence += $s.Esc + ']7;' + $uri + $s.Bel }
    $sequence += $s.Esc + ']133;A' + $s.Bel
    # Written before the original prompt runs: prompts that Write-Host their segments still
    # come after the prompt-start mark.
    [Console]::Write($sequence)
    [void](__Terminal-EnsureHooks)

    # Give the original prompt the $? and $LASTEXITCODE it would have seen without us
    # (oh-my-posh, starship and many custom prompts show the last status).
    $global:LASTEXITCODE = $nativeExit
    $text = ''
    try {
        if (-not $success) { Write-Error -Message 'previous command failed' -ErrorAction Ignore }
        $text = -join @($s.OriginalPrompt.Invoke())
    } catch {
        $text = 'PS ' + $ExecutionContext.SessionState.Path.CurrentLocation + '> '
    }
    # The console host shows "PS>" for an empty prompt; keep that behavior.
    if ($text -eq '') { $text = 'PS>' }
    $text + $s.Esc + ']133;B' + $s.Bel
}

$global:__TerminalReadLineHook = {
    # __TerminalShellIntegration (marker: this PSConsoleHostReadLine is ours)
    # PSReadLine 2.2+ (pwsh 7) reads $? first thing to color the prompt after an error: capture
    # it before any statement resets it, and hand it over below.
    $lastStatus = $?
    Set-StrictMode -Off
    $s = $global:__TerminalShellIntegration
    if (__Terminal-EnsureHooks) {
        # The prompt was replaced by the last command, so it ran without our marks: close that
        # command now and report the directory before the user types.
        if ($s.CommandRunning) {
            __Terminal-Write '133;D'
            $s.CommandRunning = $false
        }
        $uri = __Terminal-CwdUri
        if ($uri) { __Terminal-Write ('7;' + $uri) }
    }
    # PSReadLine keeps handling input, history and completion.
    if (-not $lastStatus) { Write-Error -Message 'previous command failed' -ErrorAction Ignore }
    $line = -join @($s.OriginalReadLine.Invoke())
    if ($line.Trim()) {
        $s.CommandRunning = $true
        $s.ExitCodeBefore = $global:LASTEXITCODE
        [Console]::Write($s.Esc + ']633;E;' + (__Terminal-Escape $line) + $s.Bel + $s.Esc + ']133;C' + $s.Bel)
    }
    $line
}

[void](__Terminal-EnsureHooks)
__Terminal-Write '633;P;Shell=powershell'
}
