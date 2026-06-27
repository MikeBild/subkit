#!/usr/bin/env bash
# Scene: the slash fuzzy footer + /draft, /connectors, /context, /settings.
# Reproduces the real sk REPL frames. All data is FAKE and redacted.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"

clear
banner "Shift-Tab cycles ask / auto / plan; the footer shows the mode."
sleep 0.6

# Empty composer → discoverability hint (SlashSuggest.tsx welcome hint).
printf '%b❯%b ' "$ACCENT" "$RESET"
sleep 0.5
printf '\n  %bpress %b/%b to browse 48 commands%b\n' "$DIM" "$ACCENT" "$DIM" "$RESET"
sleep 1.0

# Type "/" → the ranked fuzzy footer opens (the `›` panel).
printf '\033[2A\r\033[K'            # move up to the composer line, clear it
printf '%b❯%b ' "$ACCENT" "$RESET"
type_out "/"
printf '\n\033[K'                   # clear the old hint line
printf '%b›%b %b/%b%b\n' "$DIM" "$RESET" "$ACCENT" "$BOLD" "$RESET"
pl "    ${ACCENT}/draft${RESET}        ${DIM}— Inspect the current connector/workflow authoring state${RESET}"
pl "    ${ACCENT}/connectors${RESET}   ${DIM}— List connectors in this tenant${RESET}"
pl "    ${ACCENT}/context${RESET}      ${DIM}— Inspect the conversation context currently in scope${RESET}"
pl "    ${ACCENT}/settings${RESET}     ${DIM}— Open the 5-tab settings palette${RESET}"
pl "    ${ACCENT}/preview${RESET}      ${DIM}— Bare \`/preview\` runs now; \`show\` inspects the last result${RESET}"
pl "    ${ACCENT}/onboard${RESET}      ${DIM}— Launch an interactive onboarding wizard${RESET}"
sleep 1.8

# /draft — current authoring state.
user_line "/draft"
pl "${BOLD}draft${RESET} ${DIM}· workflow${RESET} ${ACCENT}stripe-daily-charge-summary${RESET} ${DIM}· dev · [ready_to_save]${RESET}"
pl "  ${DIM}steps${RESET}        fetch_charges → summarize → send_email"
pl "  ${DIM}connectors${RESET}   stripe-prod ${OK}●${RESET}   gmail ${OK}●${RESET}"
pl "  ${DIM}probe${RESET}        ${OK}ok${RESET} ${DIM}(2m ago)${RESET}     ${DIM}preview${RESET}  ${OK}ok${RESET} ${DIM}(412ms)${RESET}"
pl "  ${DIM}approvals${RESET}    1 pending ${DIM}· /approve to resolve${RESET}"
printf '\n'
sleep 1.4

# /connectors — tenant connector list.
user_line "/connectors"
pl "${BOLD}connectors${RESET} ${DIM}· acme-prod (4)${RESET}"
pl "  ${ACCENT}stripe-prod${RESET}     ${DIM}http   bearer    ${OK}● ok${RESET}      ${DIM}auth: ***redacted***${RESET}"
pl "  ${ACCENT}gmail${RESET}           ${DIM}http   oauth2    ${OK}● ok${RESET}      ${DIM}token refreshes in 51m${RESET}"
pl "  ${ACCENT}supabase-edge${RESET}   ${DIM}http   bearer    ${OK}● ok${RESET}      ${DIM}auth: ***redacted***${RESET}"
pl "  ${ACCENT}hubspot-crm${RESET}     ${DIM}http   oauth2    ${WARN}● needs reauth${RESET}  ${DIM}· /install to fix${RESET}"
printf '\n'
sleep 1.4

# /context — what's in scope this turn.
user_line "/context"
pl "${BOLD}context in scope${RESET} ${DIM}· conversation conv_5d81${RESET}"
pl "  ${DIM}tenant snapshot${RESET}   4 connectors · 11 workflows · 6 skills"
pl "  ${DIM}skills${RESET}            ${ACCENT}stripe-reporting${RESET}, ${ACCENT}email-summaries${RESET} ${DIM}(2 active)${RESET}"
pl "  ${DIM}knowledge${RESET}         acme-billing-glossary ${DIM}(on-demand)${RESET}"
pl "  ${DIM}memory${RESET}            SK.md ${DIM}(none in cwd)${RESET}"
pl "  ${DIM}token budget${RESET}      41,206 used · 1,871,460 remaining this month"
printf '\n'
sleep 1.4

# /settings — the 5-tab palette (Status / Config / Usage / Skills / Knowledge).
user_line "/settings"
pl "${BOLD}sk settings${RESET}"
pl "  ${ACCENT2}${BOLD}❯ Status${RESET}   ${DIM}Config    Usage    Skills    Knowledge${RESET}"
printf '  %b%s%b\n' "$DIM" "──────────────────────────────────────────────" "$RESET"
pl "  ${DIM}profile${RESET}      default ${DIM}· admin@acme-prod${RESET}"
pl "  ${DIM}engine${RESET}       subkit-api.mikebild.dev ${OK}● online${RESET}"
pl "  ${DIM}session${RESET}      7f3a9c21 ${DIM}· mode ask · view chat${RESET}"
pl "  ${DIM}model${RESET}        claude-haiku-4-5"
pl "  ${DIM}tokens${RESET}       41,206 session · 128,540 today"
pl "  ${DIM}↑/↓ select tab · enter edit · esc close${RESET}"
printf '\n'

hold 4
