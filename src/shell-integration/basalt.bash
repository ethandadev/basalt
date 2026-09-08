# Basalt shell integration for bash.
#
# Basalt starts bash with --rcfile pointing at a generated file that sources the
# user's own startup files first, then this one. macOS still ships bash 3.2, so
# everything here stays inside that dialect: no associative arrays, and
# PROMPT_COMMAND is a plain string rather than an array.

__basalt_running=""
__basalt_greeted=""

__basalt_emit_env() {
  printf '\033]1337;CurrentDir=%s\007' "$PWD"
}

__basalt_emit_commands() {
  # Aliases, functions and builtins, so completions can offer things that only
  # exist inside this shell session.
  local list
  list=$( { compgen -a; compgen -A function; compgen -b; } 2>/dev/null )
  printf '\033]1337;BasaltCmds=%s\007' "$(printf '%s' "$list" | base64 | tr -d '\n')"
}

__basalt_preexec() {
  # The DEBUG trap fires before every simple command, including the ones inside
  # PROMPT_COMMAND and inside completion. Only the first hit after a prompt is a
  # real user command.
  [ -n "$COMP_LINE" ] && return
  [ -n "$__basalt_running" ] && return
  case "$BASH_COMMAND" in
    __basalt_precmd*|"$PROMPT_COMMAND") return ;;
  esac
  __basalt_running=1
  printf '\033]133;C\007'
}

__basalt_precmd() {
  local st=$?
  if [ -n "$__basalt_running" ]; then
    printf '\033]133;D;%s\007' "$st"
    __basalt_running=""
  fi
  printf '\033]133;A\007'
  __basalt_emit_env
  if [ -z "$__basalt_greeted" ]; then
    __basalt_greeted=1
    __basalt_emit_commands
  fi
}

trap '__basalt_preexec' DEBUG
if [ -n "$PROMPT_COMMAND" ]; then
  PROMPT_COMMAND="__basalt_precmd; $PROMPT_COMMAND"
else
  PROMPT_COMMAND="__basalt_precmd"
fi

export BASALT_SHELL_INTEGRATION=1
