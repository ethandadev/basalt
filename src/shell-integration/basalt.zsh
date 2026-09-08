# Basalt shell integration for zsh.
#
# Basalt launches zsh with ZDOTDIR pointed at this directory so it can install
# hooks without ever touching the user's own dotfiles. The first thing we do is
# source the user's real startup files, then restore ZDOTDIR so that subshells,
# `exec zsh`, and anything reading $ZDOTDIR see the value they expect.

BASALT_ORIG_ZDOTDIR="${BASALT_ORIG_ZDOTDIR:-$HOME}"

if [[ -f "$BASALT_ORIG_ZDOTDIR/.zshrc" ]]; then
  ZDOTDIR="$BASALT_ORIG_ZDOTDIR" source "$BASALT_ORIG_ZDOTDIR/.zshrc"
fi

# Hand ZDOTDIR back to the user's world.
if [[ -n "$BASALT_SAVED_ZDOTDIR" ]]; then
  export ZDOTDIR="$BASALT_SAVED_ZDOTDIR"
else
  unset ZDOTDIR
fi
unset BASALT_SAVED_ZDOTDIR

# --- Marks -------------------------------------------------------------------
# OSC 133 semantic prompt marks. Basalt uses these to slice the byte stream into
# command blocks so a single command's output can be folded on its own.
#   A = a new prompt is about to be drawn
#   C = the command is about to run (everything after this is output)
#   D = the command finished, with its exit status
# Cursor position at the moment the shell falls idle after A is taken as the
# start of the input line, so no PS1 surgery is required.

__basalt_emit_env() {
  # Advertise the working directory (iTerm2-compatible) so new tabs and the
  # completion engine know where we are.
  printf '\033]1337;CurrentDir=%s\007' "$PWD"
}

__basalt_emit_commands() {
  # Sent once, at the first prompt: the names of aliases, functions and
  # builtins, so completions can offer things that only exist inside this shell.
  local list
  list="${(j:\n:)${(k)aliases}}"$'\n'"${(j:\n:)${(k)functions}}"$'\n'"${(j:\n:)${(k)builtins}}"
  printf '\033]1337;BasaltCmds=%s\007' "$(print -rn -- "$list" | base64 | tr -d '\n')"
}

__basalt_precmd() {
  local __basalt_status=$?
  if [[ -n "$__basalt_running" ]]; then
    printf '\033]133;D;%s\007' "$__basalt_status"
    __basalt_running=
  fi
  printf '\033]133;A\007'
  __basalt_emit_env
  if [[ -z "$__basalt_greeted" ]]; then
    __basalt_greeted=1
    __basalt_emit_commands
  fi
}

__basalt_preexec() {
  __basalt_running=1
  printf '\033]133;C\007'
}

autoload -Uz add-zsh-hook 2>/dev/null
if (( $+functions[add-zsh-hook] )); then
  add-zsh-hook precmd __basalt_precmd
  add-zsh-hook preexec __basalt_preexec
else
  precmd_functions+=(__basalt_precmd)
  preexec_functions+=(__basalt_preexec)
fi

export BASALT_SHELL_INTEGRATION=1
