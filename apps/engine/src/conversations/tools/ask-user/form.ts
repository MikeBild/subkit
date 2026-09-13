// ask_user_form — ask the user to fill in a structured form.

import { z } from "@hono/zod-openapi";

import { resolveConnectorTemplate } from "../../../connectors/template-resolver.ts";
import {
  resolveDraftCredentialSeedMode,
  validateCredentialFormFields,
} from "../../persistence/credential-form-contract.ts";
import type { ConversationTool, ToolResult } from "../index.ts";
import { commitIntentSchema } from "./commit-intent.ts";
import { pauseForUserInput } from "./common.ts";

/**
 * Field type contract for `ask_user_form`.
 *
 * `text` / `number` / `boolean` / `select` are the original four types.
 *
 * `password` renders as a masked input on the client and is omitted
 * from any rendered transcript (never echoed). Single-line — the server
 * rejects values containing newlines.
 *
 * `json` renders as a multi-line buffer; the client parses on blur and
 * pins a parse error inline until the buffer is valid JSON. The server
 * also re-validates with `JSON.parse(value)` so a malformed value
 * cannot reach a downstream tool through any other surface.
 *
 * `multi` is a checkbox grid. The field declares `options: string[]`
 * and the value MUST be a `string[]` subset of those options. The
 * client uses Space to toggle and Enter to confirm.
 *
 * `options` accepts two shapes:
 *   - `Array<{ value: string; label: string }>` — used by `select`
 *   - `string[]`                                 — used by `multi`
 * The renderer disambiguates on the field `type`.
 */
export const FORM_FIELD_TYPES = [
  "text",
  "number",
  "boolean",
  "select",
  "password",
  "json",
  "multi",
] as const;

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

const selectOptionSchema = z.object({ value: z.string(), label: z.string() });

const fieldSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(FORM_FIELD_TYPES),
    /**
     * `select` expects `Array<{value,label}>`. `multi` expects
     * `string[]`. Other types ignore this field. The schema accepts
     * both shapes; `validateFormFieldDefinition` enforces the
     * type-specific shape so an LLM cannot ship a `multi` field
     * without choices.
     */
    options: z.union([z.array(selectOptionSchema), z.array(z.string())]).optional(),
    placeholder: z.string().optional(),
    required: z.boolean().optional(),
    /** When true, the client must mask the field value on keystroke echo. */
    sensitive: z.boolean().optional(),
    /**
     * Optional pre-filled value the client renders as the initial input
     * state — the user confirms or edits instead of retyping. Never
     * allowed on password/sensitive fields (secrets are not pre-filled).
     * `select` defaults must match an option value; `multi` defaults
     * must be a subset of the declared options.
     */
    default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
    /**
     * Optional inline error pin shown by the renderer (e.g. "invalid
     * JSON: Unexpected token …"). The server populates this when it
     * re-prompts after a value-validation failure; the client may also
     * set it locally for immediate feedback.
     */
    error_message: z.string().optional(),
  })
  .superRefine((field, ctx) => {
    if (field.default !== undefined) {
      if (field.type === "password" || field.sensitive === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "password/sensitive fields must not carry a default — never pre-fill secrets",
          path: ["default"],
        });
      }
      if (field.type === "select") {
        const values = Array.isArray(field.options)
          ? field.options.map((o) => (typeof o === "object" && o !== null ? o.value : o))
          : [];
        if (typeof field.default !== "string" || !values.includes(field.default)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "select default must equal one of the declared option values",
            path: ["default"],
          });
        }
      }
      if (field.type === "multi") {
        const allowed = new Set(
          Array.isArray(field.options)
            ? field.options.filter((o): o is string => typeof o === "string")
            : [],
        );
        const def = field.default;
        if (!Array.isArray(def) || !def.every((v) => allowed.has(v))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "multi default must be a string[] subset of the declared options",
            path: ["default"],
          });
        }
      }
    }
    if (field.type === "multi") {
      if (!Array.isArray(field.options) || field.options.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "multi field requires `options: string[]` with at least one entry",
          path: ["options"],
        });
        return;
      }
      const allStrings = field.options.every((o) => typeof o === "string");
      if (!allStrings) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "multi field options must be `string[]` (use select for label/value pairs)",
          path: ["options"],
        });
      }
    }
    if (field.type === "select") {
      if (!Array.isArray(field.options) || field.options.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "select field requires `options: Array<{value,label}>` with at least one entry",
          path: ["options"],
        });
        return;
      }
      const allObjects = field.options.every((o) => typeof o === "object" && o !== null);
      if (!allObjects) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "select field options must be `Array<{value,label}>`",
          path: ["options"],
        });
      }
    }
  });

export type FormFieldDefinition = z.infer<typeof fieldSchema>;

const inputSchema = z
  .object({
    question: z.string().min(1),
    fields: z.array(fieldSchema).min(1),
    /**
     * Optional commit intent. When set, the harness applies the
     * intended write atomically once the operator submits — the LLM
     * does NOT need to call save_connector_draft/save_workflow_draft
     * afterwards. See `./commit-intent.ts` for the schema.
     */
    commit_intent: commitIntentSchema.optional(),
  })
  .openapi("AskUserFormInput");

/**
 * Validate a single form-value pair against its field declaration.
 * Returns `null` on success, or a `{ message }` payload the harness
 * uses to re-prompt the form with `error_message` populated.
 *
 * Centralized here so the renderer (`FormPrompt.tsx`) and the engine
 * resume path share the contract.
 */
export function validateFormFieldValue(
  field: FormFieldDefinition,
  value: unknown,
): { message: string } | null {
  switch (field.type) {
    case "password": {
      if (typeof value !== "string") return { message: "password value must be a string" };
      if (value.includes("\n") || value.includes("\r")) {
        return { message: "password must be single-line (newlines not allowed)" };
      }
      return null;
    }
    case "json": {
      if (typeof value !== "string") return { message: "json value must be a string buffer" };
      if (value.trim() === "") {
        return field.required ? { message: "json value is required" } : null;
      }
      try {
        JSON.parse(value);
        return null;
      } catch (err) {
        const reason = err instanceof Error ? err.message : "parse error";
        return { message: `invalid JSON: ${reason}` };
      }
    }
    case "multi": {
      if (!Array.isArray(value)) return { message: "multi value must be an array of strings" };
      if (!value.every((v) => typeof v === "string")) {
        return { message: "multi value must be an array of strings" };
      }
      const allowed = Array.isArray(field.options) ? field.options : [];
      const allowedSet = new Set(
        allowed
          .map((o) => (typeof o === "string" ? o : null))
          .filter((s): s is string => s !== null),
      );
      for (const v of value) {
        if (!allowedSet.has(v)) {
          return { message: `value "${v}" is not in the allowed options list` };
        }
      }
      return null;
    }
    default:
      return null;
  }
}

export const askUserFormTool: ConversationTool = {
  name: "ask_user_form",
  description:
    'Ask the user to fill in a small form of typed fields. The client renders a stacked input; the submitted {name:value} map resumes the loop. Credential field names are canonical: bearer uses `token`; basic uses `username` + `password`; header uses `header_name` + `header_value`; query uses `param_name` + `param_value`; aws_sigv4 uses `access_key_id` + `secret_access_key` with optional `session_token`. Pre-fill every value you already know via the field `default` (never on password/sensitive fields) so the user confirms instead of retyping. If you pass `commit_intent`, the harness applies the intended write atomically when the operator submits — the form value (e.g. credential) flows directly into the commit. You DO NOT need to call save_connector_draft afterward; the next turn will already see a synthetic tool result describing the persistence with source="harness_auto_persist".',
  inputSchema,
  category: "draft_write" as const,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    let args = inputSchema.parse(rawArgs);
    // Gate: if the form collects a sensitive credential (password field or
    // sensitive: true) AND a connector draft is active BUT its auth_type has
    // not been set yet, refuse early. The connector's auth shape must be
    // established via start_connector_from_description or
    // update_connector_draft before a credential can be collected — without
    // auth_type the credential cache has no mode to key on and the probe loop
    // enters credential_required repeatedly.
    const hasSensitiveField = args.fields.some(
      (f) => f.type === "password" || f.sensitive === true,
    );
    if (hasSensitiveField) {
      const draftConnector = ctx.getDraft().connector;
      if (draftConnector != null && draftConnector.auth_type == null) {
        return {
          ok: false,
          error_code: "connector_auth_unset",
          message:
            "Set the connector's auth shape before collecting a credential — call start_connector_from_description or update_connector_draft to set auth_type first.",
          next_best_actions: ["start_connector_from_description", "update_connector_draft"],
          data: { error_code: "connector_auth_unset" },
        };
      }
      // Gate: enforce the canonical credential field names at form
      // CREATION time. Pre-fix the mismatch only surfaced at submit
      // time — a form field named `basic_auth` matched no extractor
      // alias, auto-persist failed with `credential_required`, and the
      // operator had already typed the secret (session 97679846). See
      // `persistence/credential-form-contract.ts` for the table.
      if (draftConnector != null && draftConnector.auth_type !== "none") {
        const resolution = await resolveDraftCredentialSeedMode({
          connector: draftConnector,
          db: ctx.db,
          tenant_id: ctx.tenant_id,
        });
        if (resolution.seedMode) {
          const sensitiveFields = args.fields.filter(
            (field) => field.type === "password" || field.sensitive === true,
          );
          if (
            resolution.seedMode === "bearer" &&
            sensitiveFields.length === 1 &&
            !args.fields.some((field) => field.name.toLowerCase() === "token")
          ) {
            const sensitiveName = sensitiveFields[0]?.name;
            args = {
              ...args,
              fields: args.fields.map((field) =>
                field.name === sensitiveName ? { ...field, name: "token" } : field,
              ),
            };
          }
          // Slots already supplied outside the form: real (non-mustache)
          // string values in commit_intent.payload.credential (e.g. the
          // LLM pre-supplies `header_name`) plus config/template-derived
          // seed overrides (aws_region, client_id).
          const intentCredential = (args.commit_intent?.payload?.credential ?? {}) as Record<
            string,
            unknown
          >;
          const seededSlots = [
            ...Object.entries(intentCredential)
              .filter(
                ([key, value]) =>
                  key !== "mode" &&
                  typeof value === "string" &&
                  value.length > 0 &&
                  !/\{\{[^}]+\}\}/.test(value),
              )
              .map(([key]) => key),
            ...Object.keys(resolution.seedOverrides),
          ];
          const verdict = validateCredentialFormFields({
            seedMode: resolution.seedMode,
            fieldNames: args.fields.map((f) => f.name),
            seededSlots,
          });
          if (!verdict.ok) {
            // Template-bound drafts get the template's setup_instructions
            // as a hint — the canonical "where do I get this credential"
            // steps. Best-effort: a lookup failure (stub executor, db
            // blip) only drops the hint, never blocks the gate.
            let setupInstructions: string | null = null;
            if (draftConnector.template_slug) {
              try {
                const resolved = await resolveConnectorTemplate({
                  db: ctx.db,
                  tenant_id: ctx.tenant_id,
                  slug: draftConnector.template_slug,
                });
                setupInstructions = resolved?.template.setup_instructions ?? null;
              } catch {
                // hint only — fall through without it
              }
            }
            // `data` is the payload that reaches the model as the tool
            // result — the prose message and the EXPECTED field set must
            // live there, or the model thrashes re-guessing field names
            // (conversation 68b5c87e: 4 rejected forms in a row).
            return {
              ok: false,
              error_code: "credential_form_mismatch",
              message: verdict.message,
              next_best_actions: ["ask_user_form"],
              data: {
                error_code: "credential_form_mismatch",
                message: verdict.message,
                missing: verdict.missing,
                expected_fields: verdict.expected_fields,
                optional_fields: verdict.optional_fields,
                ...(setupInstructions ? { setup_instructions: setupInstructions } : {}),
              },
            };
          }
          // Re-issue draft: when `request_connector_reauth` staged this
          // draft (last_action = "connector_reauth_started") and the LLM
          // did NOT attach its own commit_intent, stamp one
          // deterministically so the existing `save_connector_draft`
          // dispatch path fires on submit instead of silently no-opping.
          // Without this stamp `extractCommitIntent` returns null,
          // `maybeAutoPersistFromElicitation` logs `auto_persist.skipped`,
          // and only the credential cache is populated — `saveConnectorAtomic`
          // (which calls `clearConnectorReauth` + emits `credential_rotated`
          // + `connector.reauth_cleared`) is never reached.
          // We derive the intent from live draft state, not from LLM input,
          // so it is always correct regardless of what the model writes.
          if (
            !args.commit_intent &&
            ctx.getDraft().summary?.last_action === "connector_reauth_started"
          ) {
            const reauthEnvironment: "dev" | "prod" =
              draftConnector.environment === "prod" ? "prod" : "dev";
            args = {
              ...args,
              commit_intent: {
                kind: "save_connector_draft",
                payload: {
                  environment: reauthEnvironment,
                  credential: { mode: resolution.seedMode },
                },
                description: `Re-issue credential for connector '${draftConnector.slug ?? draftConnector.name ?? ""}' (${reauthEnvironment})`,
              },
            };
          }
        }
      }
    }
    return pauseForUserInput(ctx, {
      tool_name: "ask_user_form",
      summary: args.question,
      input: args,
    });
  },
};
