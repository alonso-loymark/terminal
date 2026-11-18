# Shell integration for Git Bash (bash 5.1+). The terminal starts it as
#     bash.exe --rcfile <this file> -i      (with CHERE_INVOKING=1 to keep the start directory)
# and this file first reads the startup files a login shell would (Git Bash's default), so the
# user's configuration loads as usual and is never modified.
#
# Sequences: OSC 7 (cwd as a Windows path, percent-encoded UTF-8), OSC 133 A/B/C/D, OSC 633 E
# (command line) and OSC 633 P;Shell=bash (loaded). No DEBUG trap: a user's own (bash-preexec,
# starship...) keeps working.

if [ -n "${__TERMINAL_SHELL_INTEGRATION:-}" ]; then return; fi
__TERMINAL_SHELL_INTEGRATION=1

# --- the user's startup files, in login-shell order ------------------------------------------
if [ -r /etc/profile ]; then . /etc/profile; fi
if [ -r ~/.bash_profile ]; then . ~/.bash_profile
elif [ -r ~/.bash_login ]; then . ~/.bash_login
elif [ -r ~/.profile ]; then . ~/.profile
fi

# --- helpers (no subshells: forking is slow under MSYS) --------------------------------------

# Percent-encodes UTF-8 bytes except unreserved characters, "/" and ":" into __term_encoded.
__term_encode() {
  local LC_ALL=C s="$1" c n i
  __term_encoded=''
  for (( i = 0; i < ${#s}; i++ )); do
    c=${s:i:1}
    case "$c" in
      [a-zA-Z0-9._~/:-]) __term_encoded+="$c" ;;
      *) printf -v n '%d' "'$c"; printf -v c '%%%02X' $(( n & 255 )); __term_encoded+="$c" ;;
    esac
  done
}

# VS Code's OSC 633 escaping into __term_escaped.
__term_escape() {
  local s="${1//\\/\\\\}"
  s="${s//;/\\x3b}"
  s="${s//$'\n'/\\x0a}"
  s="${s//$'\r'/\\x0d}"
  s="${s//$'\t'/\\x09}"
  s="${s//$'\e'/\\x1b}"
  s="${s//$'\a'/\\x07}"
  __term_escaped="$s"
}

# file://<host>/<windows path> for $PWD into __term_uri.
__term_cwd_uri() {
  local win host="${COMPUTERNAME:-localhost}"
  if [[ "$PWD" =~ ^/([a-zA-Z])(/.*)?$ ]]; then
    win="${BASH_REMATCH[1]^^}:${BASH_REMATCH[2]:-/}"
  else
    # Outside a drive mount (/usr, /tmp...): ask MSYS for the Windows path.
    win=$(cygpath -m "$PWD" 2>/dev/null) || return 1
  fi
  if [[ "$win" == //* ]]; then
    # UNC: //server/share/dir -> file://server/share/dir
    win="${win#//}"
    host="${win%%/*}"
    win="${win#*/}"
  fi
  __term_encode "$win"
  __term_uri="file://$host/${__term_encoded#/}"
}

# --- hooks -----------------------------------------------------------------------------------
__term_status=0
__term_command_running=

# First in PROMPT_COMMAND: remember the exit status before anything else changes it.
__term_prompt_start() { __term_status=$?; }

# Last in PROMPT_COMMAND: close the command, report the directory, mark the prompt.
__term_prompt_end() {
  local sequence=''
  if [ -n "$__term_command_running" ]; then
    sequence+=$'\e]133;D;'"$__term_status"$'\a'
    __term_command_running=
  fi
  if __term_cwd_uri; then sequence+=$'\e]7;'"$__term_uri"$'\a'; fi
  printf '%s' "$sequence"
  # Prompt start/end marks around PS1, again if something rebuilt PS1 since.
  case "$PS1" in
    *'133;A'*) ;;
    *) PS1='\[\e]133;A\a\]'"$PS1"'\[\e]133;B\a\]' ;;
  esac
  return "$__term_status"
}

# Expanded by PS0 right before a command runs (in a subshell, so it can only print).
__term_preexec() {
  local line
  line=$(HISTTIMEFORMAT='' builtin history 1)
  line="${line#"${line%%[![:space:]]*}"}"   # leading spaces
  line="${line#*[[:space:]]}"               # history number
  line="${line#"${line%%[![:space:]]*}"}"
  __term_escape "$line"
  printf '\e]633;E;%s\a\e]133;C\a' "$__term_escaped"
}

# PS0: the arithmetic expansion runs in the shell itself (marks the command as running) inside
# a zero-length substring, so it prints nothing; bash skips that expansion for an unset
# variable, hence __term_x. The command substitution prints the command line and the start mark.
__term_x=x
PS0='${__term_x:0:$((__term_command_running=1,0))}$(__term_preexec)'"${PS0:-}"

# PROMPT_COMMAND may be a string or (bash 5.1+) an array: keep whatever the user set, in order.
PROMPT_COMMAND=(__term_prompt_start "${PROMPT_COMMAND[@]}" __term_prompt_end)

printf '\e]633;P;Shell=bash\a'
