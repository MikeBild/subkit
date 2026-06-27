#!/usr/bin/env bash
# Scene: the /install connector onboarding wizard
# (template picker → credentials → probe → save). FAKE + redacted data.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"

clear
banner "Use /install to add a connector: pick, fill creds, probe, save."
sleep 0.6

user_line "/install"
sleep 0.3

# Step 1 — template picker (fuzzy).
pl "${BOLD}install connector${RESET} ${DIM}· step 1/4 · pick a template${RESET}"
printf '  %b❯%b ' "$ACCENT" "$RESET"; type_out "stri"; printf '\n'
pl "    ${ACCENT}Stripe${RESET}        ${DIM}http · bearer  — payments, charges, invoices${RESET}"
pl "    ${DIM}Stripe Connect  http · oauth2  — platform / marketplace accounts${RESET}"
pl "    ${DIM}Strapi          http · bearer  — headless CMS${RESET}"
sleep 1.2
printf '  %b✓%b selected %bStripe%b %b(template: stripe)%b\n' "$OK" "$RESET" "$BOLD" "$RESET" "$DIM" "$RESET"
printf '\n'
sleep 0.8

# Step 2 — credentials (masked, redacted in audit + logs).
pl "${BOLD}install connector${RESET} ${DIM}· step 2/4 · credentials${RESET}"
pl "  ${DIM}Stripe uses a secret API key as a Bearer token.${RESET}"
printf '  %bAPI key%b ' "$DIM" "$RESET"; type_out "sk_live_"; printf '%b••••••••••••••••••••••••%b\n' "$DIM" "$RESET"
printf '  %b↳ stored encrypted · shown as %b***redacted***%b in logs + audit%b\n' "$DIM" "$WARN" "$DIM" "$RESET"
printf '  %bname%b    ' "$DIM" "$RESET"; type_out "stripe-prod"; printf '\n'
printf '  %benv%b     dev   %b[ ] prod%b\n' "$DIM" "$RESET" "$DIM" "$RESET"
printf '\n'
sleep 1.0

# Step 3 — probe.
pl "${BOLD}install connector${RESET} ${DIM}· step 3/4 · probe${RESET}"
spinner "probing stripe-prod" 3 0 0 0 "$ACCENT"
spinner_clear
pl "  ${OK}✓${RESET} GET /v1/balance ${DIM}→${RESET} ${OK}200 OK${RESET} ${DIM}· 268ms${RESET}"
pl "    ${DIM}account${RESET}   acct_1Pa•••  ${DIM}livemode${RESET} false  ${DIM}currency${RESET} usd"
pl "    ${DIM}auth header redacted · no secret written to the transcript${RESET}"
printf '\n'
sleep 1.0

# Step 4 — save.
pl "${BOLD}install connector${RESET} ${DIM}· step 4/4 · save${RESET}"
spinner "saving connector" 2 0 0 0 "$ACCENT"
spinner_clear
pl "  ${OK}✓${RESET} saved ${BOLD}stripe-prod${RESET} ${DIM}· http/bearer · dev · audit row 7c14…${RESET}"
printf '\n'
pl "${ASST}●${RESET} ${BOLD}stripe-prod${RESET} is ready. Next:"
pl "    ${ACCENT}/connectors${RESET}  ${DIM}— see it in the tenant list${RESET}"
pl "    ${ACCENT}/install${RESET}     ${DIM}— add another (gmail, hubspot, postgres…)${RESET}"
pl "    ${DIM}or just ask:${RESET} \"build a daily Stripe charge summary email\""
printf '\n'
status_line " · conn=stripe-prod:dev[saved]" "6240"
printf '\n'

hold 4
