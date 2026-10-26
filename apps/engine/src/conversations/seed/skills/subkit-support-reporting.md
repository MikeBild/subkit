---
slug: subkit-support-reporting
scope: global
title: Report a Problem to the SubKit Maintainer
description: How to take a problem report in chat - ask short follow-up questions, show exactly what will be sent and where, get one confirmation, then run the support workflows; also how to list and withdraw reports. Never ask for or include secrets.
activates_when: [{"kind":"intent_keyword","word":"report a problem"},{"kind":"intent_keyword","word":"report a bug"},{"kind":"intent_keyword","word":"report an issue"},{"kind":"intent_keyword","word":"problem melden"},{"kind":"intent_keyword","word":"fehler melden"},{"kind":"intent_keyword","word":"report to the subkit maintainer"},{"kind":"intent_keyword","word":"status of my problem report"},{"kind":"intent_keyword","word":"status meiner fehlermeldung"},{"kind":"intent_keyword","word":"withdraw my report"},{"kind":"connector_template","slug":"subkit-support"}]
side_effects: write
idempotency: key_required
maturity: stable
tags: [support, feedback, issues, reporting]
version: 1
---

# Report a Problem to the SubKit Maintainer

A report goes to the central SubKit support inbox, which the SubKit maintainer reads. It leaves this installation only after the person confirms it. Four workflows exist: `support-report-issue` (default, needs only the `subkit-support` connector), `support-report-issue-diagnostics` (additionally needs a second generic http connector on the engine's own public address), `support-list-issues` and `support-withdraw-issue`. They come from the solution recipes of the same names and need the `subkit-support` connector with the reporter key of this installation and an approved external write. Over MCP they appear with hyphens as `wf_support-report-issue`, `wf_support-report-issue-diagnostics`, `wf_support-list-issues` and `wf_support-withdraw-issue`.

## Before anything else

1. Check with `find_workflow` which of the workflows exist and that the `subkit-support` connector exists. If something is missing, name the missing slug and the required connector and tell the person how to set it up themselves: create the connector from the `subkit-support` template, then create the workflow in Cockpit with "new workflow from recipe" in the recipe catalog, or with `sk workflows create --from-recipe <slug>`. You cannot create it from a recipe with a chat tool, and you must not author the workflow from scratch or find another way to send a report.
2. The reporter key is entered by the person in the connector form. Never ask for it in chat and never repeat it.

## Taking a report

1. Ask only for what is missing, one short question at a time, using `ask_user_form` or `ask_user_choice` where a fixed set of answers fits: what happened, what was expected, how to reproduce it. Optionally which run or error message. Stop asking when a maintainer could act on it.
2. Draft a one-line title and a plain description in the person's words. Do not copy credentials, tokens, keys, passwords, personal data, customer data or full payloads into either. If the person pasted any, leave it out and say that you did.
3. Use `support-report-issue` by default. Offer diagnostics only when `support-report-issue-diagnostics` and its second http connector exist; if they do not, do not mention diagnostics. When offered, ask whether to attach them (`include_diagnostics`), explain that this adds the engine version and the latest engine errors, scrubbed of tokens, keys and e-mail addresses on a best-effort basis, so the person should still not rely on the scrub for secrets. The default is no. Only run the diagnostics variant after the person agreed.
4. Show the exact title, description and, if offered, the diagnostics choice, and the target: "This goes to the SubKit maintainer through the subkit-support connector." Let the person strike or change any part.
5. Tell the person that the preview shows exactly what the scrubber removed. Whole lines that contain password or token style keys are removed on purpose, so a line that looks gone is not a bug; they can re-add non-secret context in their own words.
6. Ask for one explicit confirmation with `ask_user_confirm`. Only after a yes run `support-report-issue`, or `support-report-issue-diagnostics` when diagnostics were agreed. Without a yes, send nothing.
7. Report the ticket number and status from the result. If the run fails, say what failed in plain words and offer one retry and tell the person that a new run can file a second report.

## Listing and status

Run `support-list-issues` for the status of the person's reports or "status of ticket N". It returns up to 50 reports of the signed-in person per page, with ticket number, status and the public note of the maintainer, and `next_cursor` when more exist. When `next_cursor` is set, offer "more" and run it again with `cursor` set to that value. Statuses: received, triaged, in_progress, resolved, wont_fix, withdrawn. State the status and the public note as they are; do not guess internal reasons.

## Withdrawing

1. Run `support-list-issues` and let the person pick the report, or use the id they give.
2. Say that a resolved or wont_fix report cannot be withdrawn.
3. Confirm with `ask_user_confirm`, then run `support-withdraw-issue` with `report_id`. Report the new status. When the result is `withdrawn: false` with `reason: not_found`, say that no report with that id was found for them and that nothing was changed. Do not say whether the id exists for someone else and do not show any other person's data.

## Never

- Never ask for, store or send secrets, keys, tokens, passwords or customer data.
- Never send without the confirmation, and never change the text after the confirmation without asking again.
- Never send on a schedule, from a webhook or on behalf of another person: the reporter comes from the signed-in caller.
- Never claim a report was delivered before the run returned a ticket number.
