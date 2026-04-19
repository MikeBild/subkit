// submit_connector_credential — persist a credential for the currently
// saved connector. The actual plaintext flows through `upsertCredential`
// which encrypts on the way in with AAD = `credential:{tenant}:{id}`.
// This tool is the LAST write in the authenticated-onboarding flow:
//   1. probe (with or without auth, to discover auth shape)
//   2. save_connector_draft (metadata row only)
//   3. ask_user_form with type=password (masked) → submit_connector_credential
//
// The plaintext enters the loop in the ask_user_form output payload that
// resumes the turn; the value is then immediately passed to
// upsertCredential and never surfaces on the tool result, the audit
// metadata, or the transcript message.

import { z } from "@hono/zod-openapi";
import { upsertCredential } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const bearerInput = z.object({ mode: z.literal("bearer"), token: z.string().min(1) });
const basicInput = z.object({
  mode: z.literal("basic"),
  username: z.string().min(1),
  password: z.string().min(1),
});
const headerInput = z.object({
  mode: z.literal("header"),
  header_name: z.string().min(1),
  header_value: z.string().min(1),
});
const queryInput = z.object({
  mode: z.literal("query"),
  param: z.string().min(1),
  value: z.string().min(1),
});

const inputSchema = z
  .object({
    connector_id: z
      .string()
      .uuid()
      .describe(
        "Saved connector id. Falls back to the conversation's target_connector_id when omitted.",
      )
      .optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
    credential: z.discriminatedUnion("mode", [bearerInput, basicInput, headerInput, queryInput]),
  })
  .openapi("SubmitConnectorCredentialToolInput");

function summarize(mode: string): string {
  return `stored ${mode} credential`;
}

export const submitConnectorCredentialTool: ConversationTool = {
  name: "submit_connector_credential",
  description:
    "Persist a credential for a saved connector after a masked `ask_user_form` submission. Never call this with plaintext that came from the model — it must be a direct relay of user input.",
  use_case:
    "Final step of authenticated onboarding. Collect the secret with `ask_user_form` (type=password + sensitive=true), then pass the resulting fields verbatim into this tool's `credential` discriminated union.",
  important_notes: [
    "Writes exactly one `credential.created` audit row; the row never includes the plaintext.",
    "Requires the connector to be saved (has an id in the connectors table). Use `save_connector_draft` first.",
    "Falls back to `ctx.getDraft().connector.saved_connector_id` when `connector_id` is omitted.",
  ],
  inputSchema,
  category: "tenant_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const draft = ctx.getDraft();
    const savedConnectorId =
      args.connector_id ?? draft.connector?.saved_connector_id ?? ctx.connector_id ?? null;
    if (!savedConnectorId) {
      return {
        ok: false,
        data: {
          error: "no_saved_connector",
          message:
            "submit_connector_credential requires a saved connector id. Save the draft first with save_connector_draft.",
        },
      };
    }
    const cred = args.credential;
    const value =
      cred.mode === "bearer"
        ? { mode: "bearer" as const, token: cred.token }
        : cred.mode === "basic"
          ? { mode: "basic" as const, username: cred.username, password: cred.password }
          : cred.mode === "header"
            ? { mode: "header" as const, headers: { [cred.header_name]: cred.header_value } }
            : { mode: "query" as const, query: { [cred.param]: cred.value } };
    const row = await upsertCredential(
      {
        tenant_id: ctx.tenant_id,
        connector_id: savedConnectorId,
        environment: args.environment,
        mode: cred.mode,
        value,
        actor_id: ctx.actor_id,
      },
      ctx.db as Db,
    );
    return {
      ok: true,
      data: {
        credential_id: row.id,
        connector_id: row.connector_id,
        environment: row.environment,
        mode: row.mode,
        summary: summarize(cred.mode),
      },
    };
  },
};
