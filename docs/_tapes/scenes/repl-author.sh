#!/usr/bin/env bash
# Scene: natural-language authoring → preview → approve → run → cost.
# Reproduces the real sk REPL frames. All data is FAKE and redacted.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"

clear
banner "\`/approve\` / \`/reject\` resolves the current confirmation inline."
sleep 0.6

# 1) Natural-language authoring prompt.
user_line "Create a workflow that fetches yesterday's Stripe charges and emails me a summary"

# 2) Spinner — verb rotation, then concrete per-tool progress (repl/spinner.tsx).
spinner "planning"                  3 0    0    1180
spinner "running find_connector"    3 3    1180 3260 "$ACCENT"
spinner "running author_workflow"   4 6    3260 6740 "$ACCENT"
spinner "running dry_run_workflow"  4 10   6740 9980 "$ACCENT"
spinner "processing 3 tool results" 3 14   9980 11420
spinner_clear

# 3) Assistant summary of the drafted workflow.
pl "${ASST}●${RESET} Drafted ${BOLD}stripe-daily-charge-summary${RESET} ${DIM}(dev)${RESET} — 3 steps:"
pl "    ${DIM}1.${RESET} ${ACCENT}fetch_charges${RESET}   stripe · GET /v1/charges?created[gte]=…  ${DIM}(http)${RESET}"
pl "    ${DIM}2.${RESET} ${ACCENT}summarize${RESET}       transform · count, gross, net, top customers ${DIM}(js)${RESET}"
pl "    ${DIM}3.${RESET} ${ACCENT}send_email${RESET}      gmail · me@acme.example ${DIM}(http)${RESET}"
pl "  ${DIM}Reused connector ${RESET}stripe-prod${DIM}; credential injected server-side (redacted).${RESET}"
printf '\n'
status_line " · wf=stripe-daily-charge-summary:dev[ready_to_preview]" "11420"
printf '\n'
sleep 1.2

# 4) /preview — dry run against the real shape, fake rows.
user_line "/preview"
spinner "running preview" 3 0 0 1860 "$ACCENT"
spinner_clear
pl "${OK}✓${RESET} preview ok ${DIM}· 412ms · 3 charges scanned${RESET}"
pl "  ${DIM}fetch_charges →${RESET} 3 rows  ${DIM}summarize →${RESET} { count: 3, gross: \$184.00, net: \$178.63 }"
pl "  ${DIM}send_email → draft:${RESET}"
pl "    ${DIM}to:${RESET}      me@acme.example"
pl "    ${DIM}subject:${RESET}  Stripe — 3 charges yesterday (\$184.00 gross)"
pl "    ${DIM}body:${RESET}     ch_3Pk•••  \$ 49.00  Acme Pro      ✓ succeeded"
pl "             ${DIM}        ch_3Pj•••  \$ 99.00  Globex Team   ✓ succeeded${RESET}"
pl "             ${DIM}        ch_3Ph•••  \$ 36.00  Initech Solo  ✓ succeeded${RESET}"
printf '\n'
sleep 1.2

# 5) /approve — resolve the pending request_human_approval inline.
user_line "/approve"
pl "${OK}✓${RESET} approved ${DIM}request_human_approval${RESET} — save + run ${BOLD}stripe-daily-charge-summary${RESET}"
sleep 0.7

# 6) Run it.
user_line "run it now"
spinner "running run_workflow" 4 0 0 2240 "$ACCENT"
spinner_clear
pl "${OK}✓${RESET} ${BOLD}exec_9a2f41c8${RESET} succeeded ${DIM}· 1.4s · 3 steps${RESET}"
pl "  ${OK}●${RESET} fetch_charges ${DIM}312ms${RESET}   ${OK}●${RESET} summarize ${DIM}4ms${RESET}   ${OK}●${RESET} send_email ${DIM}1.1s${RESET}"
pl "  ${DIM}email delivered to me@acme.example · committed v1 · audit row a31f…${RESET}"
printf '\n'
status_line " · wf=stripe-daily-charge-summary:dev[saved]" "13980"
printf '\n'
sleep 1.2

# 7) /cost — token usage + remaining budget (local, no engine call).
user_line "/cost"
pl "${BOLD}session cost${RESET}"
pl "  ${DIM}turn tokens${RESET}        13,980"
pl "  ${DIM}session tokens${RESET}     41,206   ${DIM}(in 33,914 · out 7,292)${RESET}"
pl "  ${DIM}today${RESET}             128,540"
pl "  ${DIM}monthly budget${RESET}     2,000,000   ${OK}remaining 1,871,460${RESET}"
pl "  ${DIM}model${RESET}             claude-haiku-4-5  ${DIM}· ~\$0.04 this session${RESET}"
printf '\n'

hold 4
