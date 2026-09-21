// What to DO about a manifest issue.
//
// `ManifestIssueCode` names what is wrong. On its own it is a token: a reader —
// human or model — is left to infer the fix from prose somewhere else. That gap
// is not theoretical. Asked to bound a retention workflow's removals, the
// authoring model diagnosed `dynamic_request` correctly and then invented a
// remedy out of `s3.max_keys`, a field that exists but is DERIVED from the step
// rather than authored. It never reached for `s3.scope`, because nothing it was
// holding connected the code to the field.
//
// So the remedy travels with the diagnosis. This table is the one place that
// mapping lives, in `workflows/` so the scheduler, the conversation tools and
// the cockpit can share it without a layering inversion.
//
// Text is written for whoever has to act: it names the exact field, the patch
// shape, and the traps that produced real mistakes. It deliberately does NOT
// say "explain this to the user" — it is a tool-result string, and the skills
// own the conversation.

import type { ManifestIssueCode } from "./effect-manifest.ts";

type Driver = "http" | "graphql" | "postgres" | "s3" | "mcp";

/** The one fixed target whose report profile has its own long-standing remedy. */
const GMAIL_SEND_TARGET = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

const STORAGE_SCOPE_REMEDY =
  "Author a fixed folder boundary on this step: add `s3.scope` with `key_prefix` (a narrow " +
  "existing folder ending in `/`) and `max_bytes`, plus `max_deletes` when the step removes " +
  "objects — a DELETE is eligible only with `max_deletes`. Patch it with `edit_workflow_patch` " +
  '`step_patches: [{step_id, op: "add", path: "/s3/scope", value: {…}}]`. Do NOT template ' +
  "`s3.max_keys` or `s3.paginate`: both are derived by the engine from the step and are not " +
  "author-set per-prefix limits. If one prefix cannot cover every key the step touches, split " +
  "the step into narrower per-folder steps rather than widening the prefix.";

const GMAIL_REPORT_REMEDY =
  "A reviewed report boundary is not available yet; this alone does NOT establish malformed MIME. " +
  "First inspect the exact-version preview: did this email step materialize, or was it skipped " +
  "because an upstream request was held or failed? Repair the evidenced upstream cause before " +
  "changing email construction. sk.buildMimeMessage is supported for single-part text/html or " +
  "text/plain reports; Base64 content-transfer encoding is supported. Do not infer recipients from " +
  "transform source code: review checks the materialized message. Changing report content IS " +
  "supported. Keep method POST and endpoint fixed. Set body to an object with only raw, whose " +
  "VALUE may be a dynamic reference to the encoded message. Inspect the encoding transform: " +
  "decoded MIME MUST have explicit From and To mailbox addresses, Subject, MIME-Version: 1.0, " +
  "Content-Type: text/html or text/plain; preserve agreed addresses. Do not replace report content " +
  "with a constant. Save the repaired draft, open the real review card to prepare its held " +
  "preview, and recheck eligibility. No message is sent by that preparation.";

const REMEDIES: Partial<Record<ManifestIssueCode, Partial<Record<Driver, string>>>> = {
  dynamic_request: {
    s3: STORAGE_SCOPE_REMEDY,
  },
  destructive_effect: {
    s3: STORAGE_SCOPE_REMEDY,
  },
  unbound_workflow_call: {
    http:
      "A step that calls another workflow cannot be bound for repeated runs yet. Its effects " +
      "are not part of this workflow's reviewed boundary, so there is nothing for a human to " +
      "approve. Inline the work this step delegates, or run the child workflow on its own " +
      "schedule with its own approval.",
  },
};

/**
 * The concrete remedy for one issue, or null when none is known.
 *
 * `target` lets a driver carry more than one profile: an http `dynamic_request`
 * means something different on the report-send endpoint than it does anywhere
 * else, and only the endpoint distinguishes them.
 */
export function remedyFor(
  code: ManifestIssueCode,
  driver: Driver | null | undefined,
  target?: string | null,
): string | null {
  if (code === "dynamic_request" && driver === "http" && target === GMAIL_SEND_TARGET)
    return GMAIL_REPORT_REMEDY;
  if (!driver) return null;
  return REMEDIES[code]?.[driver] ?? null;
}

/**
 * Guidance for every issue that has a known remedy, in issue order.
 *
 * A step with `missing_binding` never reaches `effects` at all (the compiler
 * skips it), so the driver is looked up leniently and an unknown one simply
 * yields no entry rather than a wrong one.
 */
export function repairGuidanceForIssues(
  issues: ReadonlyArray<{ step_id: string; code: ManifestIssueCode }>,
  effects: ReadonlyArray<{ step_id: string; driver: Driver; target: string | null }>,
): Array<{ step_id: string; code: ManifestIssueCode; instruction: string }> {
  const byStep = new Map(effects.map((effect) => [effect.step_id, effect]));
  const seen = new Set<string>();
  const guidance: Array<{ step_id: string; code: ManifestIssueCode; instruction: string }> = [];
  for (const issue of issues) {
    const effect = byStep.get(issue.step_id);
    const instruction = remedyFor(issue.code, effect?.driver, effect?.target);
    if (!instruction) continue;
    // The compiler can report the same code twice for one step (two failing
    // predicates); the reader needs the remedy once.
    const key = `${issue.step_id}:${issue.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    guidance.push({ step_id: issue.step_id, code: issue.code, instruction });
  }
  return guidance;
}
