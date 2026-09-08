# Basalt shell integration for PowerShell (5.1 and 7+).
#
# Basalt starts PowerShell with -NoExit -Command ". <this file>", which runs
# after the user's own $PROFILE has loaded, so nothing here replaces their
# prompt — it wraps whatever they already had.
#
# The marks are the same OSC 133 sequences the zsh and bash integrations emit:
#   A = a new prompt is about to be drawn
#   C = the command is about to run (everything after this is output)
#   D = the command finished, with its exit status
#
# Everything is wrapped so that a failure here can never stop the user's shell
# from starting. Windows PowerShell 5.1 has no "`e" escape, so the characters
# are built from their codes instead.

try {
  $global:BasaltEsc = [char]27
  $global:BasaltBel = [char]7
  $global:BasaltRunning = $false
  $global:BasaltGreeted = $false

  function global:__Basalt-Write([string] $text) {
    [Console]::Write($text)
  }

  function global:__Basalt-Mark([string] $body) {
    __Basalt-Write "$($global:BasaltEsc)]$body$($global:BasaltBel)"
  }

  # Advertise the working directory (iTerm2-compatible) so new tabs and the
  # completion engine know where the shell is.
  function global:__Basalt-EmitCwd {
    try {
      $here = $PWD.ProviderPath
      if ($here) { __Basalt-Mark "1337;CurrentDir=$here" }
    } catch { }
  }

  # Sent once, at the first prompt: the names of aliases, functions and cmdlets,
  # so completions can offer things that only exist inside this session.
  function global:__Basalt-EmitCommands {
    try {
      $names = @()
      $names += (Get-Command -CommandType Alias, Function, Cmdlet -ErrorAction SilentlyContinue |
                 Select-Object -ExpandProperty Name -ErrorAction SilentlyContinue)
      if ($names.Count -gt 0) {
        $joined = ($names -join "`n")
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($joined))
        __Basalt-Mark "1337;BasaltCmds=$encoded"
      }
    } catch { }
  }

  # Keep the user's prompt and call it for the visible part.
  if (-not $global:BasaltOriginalPrompt) {
    $global:BasaltOriginalPrompt = $function:prompt
  }

  # PSConsoleHostReadLine is what the host calls to read a command line, so
  # wrapping it is the one reliable place to learn that a command is about to
  # run. It does not exist yet while this file is being dot-sourced — PSReadLine
  # is imported when the interactive loop starts, which is afterwards — so the
  # hook is installed from the first prompt instead, by which time it is there.
  function global:__Basalt-HookReadLine {
    if ($global:BasaltReadLineHooked) { return }
    if (-not (Get-Command PSConsoleHostReadLine -ErrorAction SilentlyContinue)) { return }
    if (-not $global:BasaltOriginalReadLine) {
      $global:BasaltOriginalReadLine = $function:PSConsoleHostReadLine
    }
    if (-not $global:BasaltOriginalReadLine) { return }

    function global:PSConsoleHostReadLine {
      $line = & $global:BasaltOriginalReadLine
      try {
        $global:BasaltRunning = $true
        __Basalt-Mark '133;C'
      } catch { }
      $line
    }
    $global:BasaltReadLineHooked = $true
  }

  function global:prompt {
    # $? and $LASTEXITCODE have to be read before anything else runs.
    $succeeded = $?
    $native = $global:LASTEXITCODE

    try {
      if ($global:BasaltRunning) {
        # $LASTEXITCODE keeps the value of the last *native* command, so it goes
        # stale across cmdlets that never set it. $? is what actually says
        # whether the thing that just ran succeeded.
        if ($succeeded) { $code = 0 }
        elseif ($null -ne $native -and $native -ne 0) { $code = $native }
        else { $code = 1 }
        __Basalt-Mark "133;D;$code"
        $global:BasaltRunning = $false
      }
      __Basalt-Mark '133;A'
      __Basalt-EmitCwd
      if (-not $global:BasaltGreeted) {
        $global:BasaltGreeted = $true
        __Basalt-EmitCommands
      }
      __Basalt-HookReadLine
    } catch { }

    # Restore what the user's own prompt expects to see.
    $global:LASTEXITCODE = $native
    if ($global:BasaltOriginalPrompt) {
      & $global:BasaltOriginalPrompt
    } else {
      "PS $($PWD.Path)> "
    }
  }

  $env:BASALT_SHELL_INTEGRATION = '1'
} catch {
  # A broken integration must never cost the user their shell.
}
