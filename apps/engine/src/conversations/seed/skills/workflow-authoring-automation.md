---
slug: workflow-authoring-automation
scope: global
title: Workflow Automation Readiness
description: Finishing a saved workflow for automatic operation: the in-chat review, automation states, previews with saved schedule input, repair preparation before the review card, and how to talk to the user meanwhile.
activates_when: [{"kind":"tool","tool":"review_workflow_automation"},{"kind":"tool","tool":"list_schedules"},{"kind":"tool","tool":"save_workflow_draft"},{"kind":"tool","tool":"run_workflow"},{"kind":"intent_keyword","word":"automatisch"},{"kind":"intent_keyword","word":"automatic"},{"kind":"intent_keyword","word":"recurring"},{"kind":"intent_keyword","word":"regelmäßig"},{"kind":"intent_keyword","word":"automatischen betrieb"},{"kind":"intent_keyword","word":"automatic operation"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, workflow, automation]
version: 1
---

# Workflow Automation Readiness

## Chat completion and human review

In cockpit, a saved draft is reviewed inside the current chat with “Review saved change”. This opens the exact-version effect and limit dialog; the human can apply the change and allow bounded automatic runs in one decision. Never send API commands, ask the user to activate externally, or use call_connector to call the engine. Use review_workflow_automation to render the actual bounded review card in chat. Never use ask_user_confirm for recurring-run permission: it cannot create execution authority. A held-write preview does not send an email and is not a live test. Report these outcomes separately. A repaired credential alone does not authorize a changed workflow. If run_workflow reports activation required, stop retrying and point to the chat review action. If access preparation fails, inspect the precise connector/environment once and repair the evidenced problem; do not invent cache or checkpoint causes. Never claim the next scheduled run will happen without observed authorized automation status.

## Automatic operation completion

- Inspect `list_schedules` for the workflow after preparation and before claiming that automatic operation is ready. Read `automation.state`, not just `paused`.
- `repair_required`: a successful preview is insufficient; resolve the reported unsupported effect boundary. If this cannot be supported without changing the business result, ask one short business question with a recommendation. Do not repeat an unchanged preview or the same preparation handoff indefinitely.
- `approval_required`: explain that preparation is finished and automatic runs still need the user's bounded permission. Point to the automatic-run review available directly in the chat. A choice to keep the schedule unchanged is not this permission.
- `activation_required`, `paused`, `input_required`, or `verification_unavailable`: name the missing step briefly; never promise the next automatic run.
- Only `authorized` is evidence of current permission; it is rechecked at dispatch. Do not claim that an actual run succeeded until its execution record confirms that.
- User-facing questions and labels describe outcomes (for example “Bericht veröffentlichen”), never parameters such as `publish=true`, raw cron expressions or tool names.

## Preview existing scheduled work with its real settings

When repairing a scheduled workflow, omit `input` from `dry_run_workflow` to reuse the single enabled schedule in the selected environment. Do not send an empty object or fabricate IDs, sites, repositories or dates: reads contact real systems. If schedules are ambiguous, inspect them and ask only the missing business choice. A preview failure caused by absent or invented input is not evidence that the workflow works; repair the input and rerun. Never propose a forced save to conceal that failure. Use `inspect_workflow_draft` with `step_ids` for targeted current configuration rather than repeatedly loading full old execution results.

## Repair preparation before handoff

When a user asks to prepare missing recurring permission, inspect the saved definition and current readiness first. A repeated successful held-write preview does not repair missing boundaries. If a supported boundary is missing, prepare the actual inert draft change and verify it; do not merely describe the problem or call it ready. Preserve the full existing storage key prefix (including namespace segments such as `v1/`), schedule, destinations and business inputs. Use a readiness card only after actual preparation or to explain a specific remaining unsupported capability. Do not say the user's approval is the only missing action while `automation.state` is `repair_required`. After `save_workflow_draft`, read `automation_readiness` in its result: when `eligible_for_repeated_runs` is false, follow its `repair_guidance` step by step, preview and save again in the SAME turn. Do not call `review_workflow_automation` before it reports eligible — that tool ends the turn with the card, and a human cannot repair a refused boundary from a card. A green preview proves the requests fit their boundaries; only `automation_readiness` says whether every boundary was accepted.

## User dialogue

Technical diagnosis belongs in tool calls, not in the conversation narrative. Do not stream your debugging hypotheses, patch paths, payload shapes, encoding details or internal error names to the user. A suitable progress sentence is “Ich prüfe, was den regelmäßigen Versand blockiert.” Give the verified business result and one actionable review card afterwards. Ask only about an unresolved business choice; never ask the user to choose an encoding, repair a patch or validate a technical diagnosis.

Preparation is not a request to perform the workflow now. For an already-saved workflow, use `run_workflow` with `execute_writes: false`, even when a `wf_<slug>` tool is available. That runs the ACTIVE version. When this chat holds a saved change that still awaits review, preview that change with `dry_run_workflow` instead — `run_workflow` refuses while a saved change is pending, and a refusal is not a reason to show the review card unchecked. When `dry_run_workflow` reports `unverified_boundaries`, those steps were skipped in the preview: compare each one's folder, size or target with the same step in the last real run (`inspect_execution_step`) or with the transform that builds it, and correct it before the review card. The synthetic tool is for an explicitly requested live run and can open a one-shot confirmation; do not use that confirmation as a substitute for recurring automation review.

When checking an existing scheduled workflow, use its saved schedule inputs. `run_workflow` with `execute_writes: false` and omitted input inherits the single enabled schedule in the chosen environment; passing `{}` explicitly does not. Do not diagnose empty loop iterations as a workflow defect until you have checked the actual input. Never ask the user to reconstruct technical input already stored in the schedule. A fixed URL may still be blocked by a dynamic body or unsupported operation: read the manifest and actual request before claiming the URL is the cause. Unsupported engine capabilities cannot be repaired by pretending a one-off run is recurring permission. Explain that limitation briefly; do not offer “ignore the scheduler” as a repair.

Absence of a report-delivery boundary is missing evidence, NOT proof of malformed email. First check whether the exact-version held preview reached the email step. If an upstream request was held or failed, diagnose that upstream result; rewriting MIME cannot fix missing input. When the email step was held, its `report_delivery_inspection` names the rule the message broke (`not_utf8`, `header_control_byte`, `extra_recipients`, …); start there. The built-in `sk.buildMimeMessage` produces what the review accepts: one sender and one recipient, each `addr` or `Name <addr>`, a Unicode subject, and a UTF-8 text/plain or text/html body, or both as `multipart/alternative`. Do not replace it merely because it is a helper. Hand-built MIME must be encoded with `sk.base64UrlEncodeUtf8`, never `sk.base64UrlEncode`, which keeps one byte per character. Cc, Bcc, Reply-To, custom headers and attachments stay outside the review. Sender and recipient are checked on the materialized message, not inferred from transform source code. Inspect the actual step shape before applying a patch; never guess a `config` wrapper. A successful run with held prerequisites does not verify skipped downstream steps.

Own the preparation: inspect, check, repair and save within the actual permission mode. Never ask the user to invoke a tool or interpret code. “Do not run live” still allows the permitted hold-writes preview; an explicit prohibition of previews does not. Preserve existing schedules and destinations unless the user requests a change. Resolve genuinely missing business input through `ask_user_choice`, `ask_user_text` or `ask_user_form`: one short question, clear effects, and a grounded recommendation. Use the canonical confirmation tool for required authority. Report the verified result in 1–3 sentences; no field tables, code or tool names unless requested.
