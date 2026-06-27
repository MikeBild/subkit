# Shared rendering helpers for the sk REPL demo "scenes".
#
# These scenes are scripted reproductions of the real `sk` REPL frames —
# the round-border welcome banner (repl/welcome-banner.tsx), the braille
# thinking spinner with rotating verb + elapsed + token count
# (repl/spinner.tsx), the slash fuzzy footer (repl/slash/SlashSuggest.tsx),
# the status line (repl/status-line/render.ts), and the slash catalog
# (apps/sk/src/slash.ts).
#
# We replay frames instead of driving the live REPL so the docs GIFs are
# deterministic and render offline (no engine, no auth, no secrets). All
# data below is FAKE and redacted on purpose. To refresh the GIFs against
# a live engine, point a tape at `sk` directly and re-record.

set -u

ESC=$'\033'
RESET="${ESC}[0m"
BOLD="${ESC}[1m"
DIM="${ESC}[38;5;245m"     # severity.dim
USERC="${ESC}[38;5;117m"   # role.user (cyan)
ASST="${ESC}[38;5;183m"    # role.assistant (mauve)
ACCENT="${ESC}[38;5;80m"   # accent.primary (teal)
ACCENT2="${ESC}[38;5;215m" # accent.secondary (peach) — fuzzy match hit
WARN="${ESC}[38;5;221m"    # severity.warning (yellow) — also `ask` mode
OK="${ESC}[38;5;114m"      # severity.success (green)
ERR="${ESC}[38;5;210m"     # severity.error (red)

# ---- low-level -------------------------------------------------------------

p()  { printf '%b' "$1"; }
pl() { printf '%b\n' "$1"; }

# Typewriter effect — prints a string char by char.
type_out() {
  local s="$1" d="${2:-0.022}" i
  for (( i = 0; i < ${#s}; i++ )); do
    printf '%s' "${s:i:1}"
    sleep "$d"
  done
}

# A user input line at the composer prompt, typed out then committed.
user_line() {
  local text="$1"
  printf '%b❯%b ' "$ACCENT" "$RESET"
  type_out "$text"
  printf '\n'
  sleep 0.35
}

# ---- welcome banner --------------------------------------------------------

INNER=74

# boxline <colored-content> <plain-content-for-width>
boxline() {
  local colored="$1" plain="$2"
  local pad=$(( INNER - 1 - ${#plain} ))
  (( pad < 0 )) && pad=0
  printf '%b│%b %b%b%*s%b│%b\n' "$DIM" "$RESET" "$colored" "$RESET" "$pad" "" "$DIM" "$RESET"
}

box_top()    { printf '%b╭%s╮%b\n' "$DIM" "$(printf '─%.0s' $(seq 1 $INNER))" "$RESET"; }
box_bottom() { printf '%b╰%s╯%b\n' "$DIM" "$(printf '─%.0s' $(seq 1 $INNER))" "$RESET"; }

# Render the orientation banner. $1 = optional one-line tip.
banner() {
  local tip="${1:-Use /resume to reopen a prior session without replaying the full transcript.}"
  box_top
  boxline "${BOLD}sk${RESET}${DIM} · profile default${RESET}" \
          "sk · profile default"
  boxline "${USERC}${BOLD}admin@acme-prod${RESET}${DIM} · subkit-api.mikebild.dev · session ${RESET}${ASST}7f3a9c21${RESET}" \
          "admin@acme-prod · subkit-api.mikebild.dev · session 7f3a9c21"
  boxline "${WARN}${BOLD}ask${RESET}${DIM} · chat · online${RESET}" \
          "ask · chat · online"
  boxline "Resume work, create a connector, or build a workflow — just ask." \
          "Resume work, create a connector, or build a workflow — just ask."
  boxline "" ""
  # Defensive clamp: keep the tip inside the box so a long tip can't
  # blow out the right border.
  local tip_plain="◦ ${tip}"
  if (( ${#tip_plain} > INNER - 1 )); then
    tip_plain="${tip_plain:0:$(( INNER - 2 ))}…"
    tip="${tip:0:$(( INNER - 4 ))}…"
  fi
  boxline "${WARN}◦ ${DIM}${tip}${RESET}" "$tip_plain"
  boxline "" ""
  boxline "${DIM}type a request · ${ASST}/help${DIM} · ${ASST}/resume${DIM} · ${ASST}/view inspect${DIM} · ${ASST}Ctrl-O${DIM} inspect${RESET}" \
          "type a request · /help · /resume · /view inspect · Ctrl-O inspect"
  box_bottom
  printf '\n'
}

# ---- spinner ---------------------------------------------------------------

SPIN_FRAMES=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")

# spinner <label> <seconds> <base_elapsed_s> <tok_start> <tok_end> [color]
# Animates the braille glyph + label + elapsed + token count, matching
# repl/spinner.tsx ("running build_workflow…  12s · 8420t").
spinner() {
  local label="$1" secs="$2" base="$3" t0="$4" t1="$5" col="${6:-$WARN}"
  local ticks=$(( secs * 8 )) i
  (( ticks < 1 )) && ticks=1
  for (( i = 0; i < ticks; i++ )); do
    local f="${SPIN_FRAMES[$(( i % 10 ))]}"
    local elapsed
    elapsed=$(awk "BEGIN{printf \"%d\", $base + $i*0.125}")
    local tok=$(( t0 + (t1 - t0) * i / ticks ))
    printf '\r%b%s %b%s…%b  %ds · %dt%b\033[K' \
      "$col" "$f" "$BOLD" "$label" "$DIM" "$elapsed" "$tok" "$RESET"
    sleep 0.125
  done
}

spinner_clear() { printf '\r\033[K'; }

# ---- status line -----------------------------------------------------------

# status_line <authoring-chip> <turn-tokens>
status_line() {
  local chip="$1" tok="$2"
  printf '%b%bask%b%b · acme-prod · subkit-api.mikebild.dev%s · %st%b\n' \
    "$DIM" "$WARN" "$RESET" "$DIM" "$chip" "$tok" "$RESET"
}

# Hold the final frame so the GIF lingers on the last state.
hold() { sleep "${1:-3}"; }
