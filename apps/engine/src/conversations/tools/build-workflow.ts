// `build_workflow` — one-shot authoring tool.
//
// Writes the entire draft in a single call: name, slug, description,
// steps, input_schema, output_transform, output_schema. The LLM is
// expected to use this when it already knows the full plan (e.g. after
// a discovery run or after a couple of `probe_connector` calls).
//
// Guards applied before the draft is accepted:
//
//   1. Schema shape — WorkflowDef zod validator from workflows/types.
//   2. Reference integrity on placeholders — every `${cred.<slug>.<field>}`
//      and `${connector.<slug>.*}` must point at a connector that exists
//      in the conversation's environment, and credential tokens must
//      match fields present on the decrypted credential.
//   3. Optional sample → schema inference for the input_schema.
//
// On any guard failure the draft is NOT persisted; the tool returns a
// WriteResult with code + details so the LLM can correct and retry in
// the next turn.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { connectors as connectorsTable } from "../../db/schema/index.ts";
import { describeConnectorPlaceholders, parsePlaceholders } from "../../llm/substitution/index.ts";
import { sampleToSchema } from "../../workflows/sample-to-schema.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import type { DraftDocument } from "../types.ts";
import { verifyWorkflow } from "../verifier.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const StepShape = z.record(z.string(), z.unknown());

const BuildWorkflowInput = z
  .object({
    name: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]{0,63}$/u, "slug must match /^[a-z][a-z0-9_-]{0,63}$/"),
    description: z.string().max(2000).optional(),
    steps: z.array(StepShape).min(1).max(200),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    /** Sample input payload; the tool infers `input_schema` from it if
     *  `input_schema` is not provided. */
    input_schema_sample: z.unknown().optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    output_transform: z.string().optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
  })
  .openapi("BuildWorkflowToolInput");

interface PlaceholderProblem {
  token: string;
  code: "placeholder_connector_missing" | "placeholder_cred_missing";
  detail: string;
}

/** Walk an arbitrary value and return every string leaf. Used to scan
 *  step configs + transform expressions for placeholder tokens. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
    return out;
  }
  return out;
}

export const buildWorkflowTool: ConversationTool = {
  name: "build_workflow",
  description:
    "Write an entire workflow draft in a single call. Validates the schema, checks placeholder references, and optionally infers input_schema from a sample.",
  use_case:
    "Use when you already know the full workflow structure — typically after probing connectors or after approving discovery artifacts. Saves 5–7 round-trips versus the incremental propose_step → connect_steps flow.",
  important_notes: [
    "Does NOT persist the workflow; it writes to the conversation draft. Call `commit_draft` after `ask_user_confirm(kind='commit_draft')` to save.",
    "Every `${cred.<slug>.<field>}` and `${connector.<slug>.*}` must reference an existing connector + field in the target environment; mismatches yield placeholder_connector_missing / placeholder_cred_missing with exact token names.",
    "If you pass `input_schema_sample` (a concrete payload) and omit `input_schema`, the tool infers a minimal JSON schema — accept the result or override explicitly.",
    "Replaces any in-progress draft on the conversation (idempotent): subsequent `build_workflow` calls overwrite the draft cleanly.",
  ],
  requires_skill: "workflow-authoring",
  example_input: {
    name: "Daily Stripe customers",
    slug: "stripe-daily-customers",
    steps: [
      {
        id: "fetch",
        kind: "request",
        connector_id: "00000000-0000-0000-0000-000000000000",
        method: "GET",
        path: "/v1/customers",
        headers: { Authorization: "Bearer ${cred.stripe.token}" },
      },
    ],
    environment: "dev",
  },
  inputSchema: BuildWorkflowInput,
  category: "draft_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const parsed = BuildWorkflowInput.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        data: {
          persistence: "none" as const,
          error: {
            code: "invalid_input",
            message: "input failed zod validation",
            details: {
              issues: parsed.error.issues.map((i) => ({
                path: i.path.join("."),
                message: i.message,
                code: i.code,
              })),
            },
          },
        },
      };
    }
    const args = parsed.data;

    // Schema shape + step discriminated union.
    const defValidation = WorkflowDefSchema.safeParse({
      name: args.name,
      slug: args.slug,
      ...(args.description ? { description: args.description } : {}),
      ...(args.input_schema ? { input_schema: args.input_schema } : {}),
      ...(args.output_schema ? { output_schema: args.output_schema } : {}),
      steps: args.steps,
    });
    if (!defValidation.success) {
      return {
        ok: false,
        data: {
          persistence: "none" as const,
          error: {
            code: "workflow_schema_invalid",
            message: "workflow definition failed schema validation",
            details: {
              issues: defValidation.error.issues.map((i) => ({
                path: i.path.join("."),
                message: i.message,
                code: i.code,
              })),
            },
          },
        },
      };
    }

    // Placeholder reference-integrity. Scan every string leaf across
    // steps + output_transform for `${cred.*}` / `${connector.*}`.
    const stringLeaves = collectStrings(args.steps);
    if (args.output_transform) stringLeaves.push(args.output_transform);
    const tokensSeen = new Set<string>();
    const tokens: Array<{ kind: string; slug: string; field?: string; raw: string }> = [];
    for (const s of stringLeaves) {
      const { tokens: parsedTokens } = parsePlaceholders(s);
      for (const t of parsedTokens) {
        if (tokensSeen.has(t.raw)) continue;
        tokensSeen.add(t.raw);
        if (t.kind === "cred") {
          tokens.push({ kind: t.kind, slug: t.slug!, field: t.field!, raw: t.raw });
        } else if (t.kind === "connector_url" || t.kind === "connector_config") {
          tokens.push({ kind: t.kind, slug: t.slug!, raw: t.raw });
        }
      }
    }

    const problems: PlaceholderProblem[] = [];
    // Resolve every distinct connector slug once.
    const distinctSlugs = new Set(tokens.map((t) => t.slug));
    const slugToConnectorId = new Map<string, string | null>();
    const slugToPlaceholders = new Map<
      string,
      { credentials: string[]; url: string | null; config: string[] }
    >();
    for (const slug of distinctSlugs) {
      const rows = await ctx.db
        .select()
        .from(connectorsTable)
        .where(
          and(
            eq(connectorsTable.tenant_id, ctx.tenant_id),
            eq(connectorsTable.slug, slug),
            eq(connectorsTable.environment, args.environment),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) {
        slugToConnectorId.set(slug, null);
        continue;
      }
      slugToConnectorId.set(slug, row.id);
      const descr = await describeConnectorPlaceholders(slug, {
        tenant_id: ctx.tenant_id,
        environment: args.environment,
        db: ctx.db,
      });
      slugToPlaceholders.set(slug, descr);
    }

    for (const tok of tokens) {
      if (slugToConnectorId.get(tok.slug) === null) {
        problems.push({
          token: tok.raw,
          code: "placeholder_connector_missing",
          detail: `connector slug '${tok.slug}' not found in ${args.environment}`,
        });
        continue;
      }
      if (tok.kind === "cred") {
        const descr = slugToPlaceholders.get(tok.slug);
        const credTokens = descr?.credentials ?? [];
        if (!credTokens.includes(tok.raw)) {
          problems.push({
            token: tok.raw,
            code: "placeholder_cred_missing",
            detail: `credential field '${tok.field ?? ""}' is not defined on connector '${tok.slug}'; known fields: ${credTokens.join(", ") || "(none configured)"}`,
          });
        }
      }
    }

    if (problems.length > 0) {
      const firstCode = problems[0]!.code;
      return {
        ok: false,
        data: {
          persistence: "none" as const,
          error: {
            code: firstCode,
            message:
              "one or more placeholder references are unresolved against the current environment",
            details: { problems },
          },
        },
      };
    }

    // Static verification: JSONata parse, scope-ref integrity, method
    // safety hints, output_schema sanity. Errors block the draft;
    // warnings + infos surface in the response so the author can decide
    // to ignore or fix.
    const verdict = verifyWorkflow({
      name: args.name,
      slug: args.slug,
      ...(args.description ? { description: args.description } : {}),
      steps: args.steps,
      ...(args.output_schema ? { output_schema: args.output_schema } : {}),
      ...(args.output_transform ? { output_transform: args.output_transform } : {}),
    });
    if (verdict.errors.length > 0) {
      return {
        ok: false,
        data: {
          persistence: "none" as const,
          error: {
            code: "verifier_rejected",
            message: `static verifier found ${verdict.errors.length} error(s)`,
            details: {
              errors: verdict.errors,
              warnings: verdict.warnings,
              infos: verdict.infos,
            },
          },
        },
      };
    }

    // Input schema inference.
    let input_schema = args.input_schema;
    const warnings: string[] = [];
    if (!input_schema && args.input_schema_sample !== undefined) {
      input_schema = sampleToSchema(args.input_schema_sample);
      warnings.push("input_schema_inferred_from_sample");
    }

    // Draft shape accepted by the conversation draft store.
    const draft: DraftDocument = {
      name: args.name,
      slug: args.slug,
      steps: args.steps,
    };
    if (args.description) draft.description = args.description;
    if (input_schema) draft.input_schema = input_schema;
    if (args.output_schema) draft.output_schema = args.output_schema;

    await ctx.setDraft(draft);

    return {
      ok: true,
      data: {
        persistence: "draft_only" as const,
        draft: {
          slug: args.slug,
          name: args.name,
          step_count: args.steps.length,
          input_schema_inferred: input_schema !== undefined && args.input_schema === undefined,
        },
        warnings: [...warnings, ...verdict.warnings.map((w) => `${w.code}:${w.path}`)],
        infos: verdict.infos.map((i) => `${i.code}:${i.path}`),
      },
    };
  },
};
