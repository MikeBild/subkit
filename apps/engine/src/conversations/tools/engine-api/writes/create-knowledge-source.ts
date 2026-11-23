import { z } from "@hono/zod-openapi";
import { executionDataFileIds } from "../../../../files/model-context.ts";
import type { FileRow } from "../../../../files/resolver.ts";
import { requireFileForTenant, resolvedFromRow } from "../../../../files/resolver.ts";
import {
  ANONYMOUS_COLLECTOR,
  assistantIntakeRequestId,
  checkIntakeFile,
  createIntakeItem,
  type IntakeCollector,
  IntakeConflictError,
  intakeFileBody,
  intakeItemByRequestId,
} from "../../../../knowledge/index.ts";
import { now } from "../../../../utils/index.ts";
import { connectorActorFromToolContext } from "../../audit-actor.ts";
import type { ConversationTool, ToolContext, ToolResult } from "../../index.ts";

const CreateKnowledgeSourceInput = z
  .object({
    mode: z.enum(["inline", "from_attachment"]),
    name: z.string().min(1).max(200).optional(),
    content: z.string().min(1).optional(),
    source_uri: z.string().url().optional(),
    file_id: z.string().regex(/^fid_/, "file_id must start with 'fid_'").optional(),
    description: z.string().max(2000).optional(),
  })
  .refine(
    (v) => {
      if (v.mode === "inline") return Boolean(v.name && v.content);
      if (v.mode === "from_attachment") return Boolean(v.file_id);
      return false;
    },
    {
      message:
        "mode='inline' requires 'name' and 'content'; mode='from_attachment' requires 'file_id'",
    },
  )
  .openapi("CreateKnowledgeSourceToolInput");

async function readAllBytes(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function defaultNameFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  return base.length > 0 ? base : filename;
}

const GENERIC_NAME_PATTERNS = [
  /^uploaded\s+knowledge\s+source$/i,
  /^uploaded\s+file$/i,
  /^uploaded\s+document$/i,
  /^uploaded\s+content$/i,
  /^new\s+knowledge\s+source$/i,
  /^new\s+file$/i,
  /^new\s+document$/i,
  /^pasted\s+(content|text|document|file)$/i,
  /^attachment$/i,
  /^file$/i,
  /^document$/i,
  /^content$/i,
  /^untitled$/i,
  /^untitled[-_\s]\d+$/i,
  /^knowledge\s+source$/i,
];

function isGenericName(name: string): boolean {
  return GENERIC_NAME_PATTERNS.some((re) => re.test(name.trim()));
}

export { isGenericName };

function intakeCollector(ctx: ToolContext): IntakeCollector {
  const actor = connectorActorFromToolContext(ctx);
  return actor && "id" in actor ? actor : ANONYMOUS_COLLECTOR;
}

const REVIEW_NEXT_ACTION =
  "The content was collected for review and is not team knowledge yet. A person opens the knowledge inbox in Cockpit, checks the item and decides whether to admit it. Tell the person that, and do not claim the knowledge was saved.";

export const createKnowledgeSourceTool: ConversationTool = {
  name: "create_knowledge_source",
  description:
    "Collect content for the team's knowledge review. Nothing becomes searchable team knowledge through this tool: it puts an item into the knowledge inbox, where a person checks it and decides whether to admit it. Accepts inline markdown/text/JSON (mode='inline' with name + content) or an existing conversation attachment (mode='from_attachment' with file_id; text, PDF and image files). For mode='from_attachment', OMIT `name` unless the user explicitly named it — the title is derived from the filename. NEVER invent generic placeholders like 'Uploaded Knowledge Source' or 'Attachment'.",
  use_case:
    "Use when the user asks to add a file, document, or pasted content to the team's knowledge. If the prompt contains a `{\"$file\":\"fid_…\"}` leaf, use mode='from_attachment' with that file_id AND OMIT `name`. For pasted text, use mode='inline'. If the user mentions a path string but no fid_… is present, the file was not available to subkit — ask the user to check the path rather than calling this tool with the raw path string as `content`.",
  important_notes: [
    "The result is an inbox item, not a knowledge source: search_knowledge will not find it until a person admits it in Cockpit.",
    "Repeating the call with the same content in the same conversation returns the same inbox item.",
    "Secrets that look like keys or tokens are removed from the collected text.",
    "A signed-in person can still add knowledge directly in Cockpit or with the CLI.",
  ],
  example_input: {
    mode: "inline",
    name: "Refund policy",
    content: "# Refund policy\n\nRefunds above 500 EUR need a second approver.",
  },
  inputSchema: CreateKnowledgeSourceInput,
  category: "tenant_write",
  permission: { action: "knowledge:write", resourceType: "knowledge" },
  async execute(ctx, args: z.infer<typeof CreateKnowledgeSourceInput>): Promise<ToolResult> {
    let title: string;
    let body: string;
    let attachment:
      | { file_id: string; filename: string; content_type: string; size_bytes: number }
      | undefined;

    if (args.mode === "from_attachment") {
      const file_id = args.file_id as string;
      let row: FileRow;
      try {
        row = await requireFileForTenant(ctx.db, ctx.tenant_id, file_id);
      } catch (err) {
        return {
          ok: false,
          data: {
            error: "file_not_found",
            reason: err instanceof Error ? err.message : String(err),
            file_id,
          },
        };
      }
      if ((await executionDataFileIds(ctx.db, ctx.tenant_id, [row.id])).has(row.id))
        return {
          ok: false,
          data: {
            error: "execution_data_only",
            reason:
              "This file is reserved for direct workflow transfer and cannot enter knowledge or model context.",
          },
        };
      const resolved = resolvedFromRow(row);
      const bytes = await readAllBytes(await resolved.openRead());
      const checked = checkIntakeFile(resolved.content_type ?? "", bytes);
      if (!checked.ok)
        return {
          ok: false,
          data: {
            error: checked.reason,
            reason:
              "Only text, CSV, JSON, PDF and image files can be collected for review. Ask the person to add other formats in Cockpit.",
          },
        };
      const facts = {
        file_id: row.id,
        filename: resolved.filename,
        content_type: checked.content_type,
        size_bytes: bytes.byteLength,
      };
      attachment = facts;
      title =
        args.name && !isGenericName(args.name)
          ? args.name
          : defaultNameFromFilename(resolved.filename);
      body = intakeFileBody(facts, checked.text);
    } else {
      title = args.name as string;
      body = args.content as string;
    }

    const client_request_id = assistantIntakeRequestId([
      ctx.conversation_id,
      args.mode,
      title,
      attachment?.file_id ?? body,
    ]);
    try {
      const replayed = await intakeItemByRequestId(ctx.db, ctx.tenant_id, client_request_id);
      const item =
        replayed ??
        (await createIntakeItem(
          {
            tenant_id: ctx.tenant_id,
            actor: intakeCollector(ctx),
            client_request_id,
            title,
            body,
            captured_at: new Date(now()).toISOString(),
            ...(args.mode === "inline" && args.source_uri ? { source_url: args.source_uri } : {}),
            ...(args.description !== undefined ? { note: args.description } : {}),
            ...(attachment ? { attachment } : {}),
          },
          ctx.db,
        ));
      return {
        ok: true,
        data: {
          collected: true,
          admitted: false,
          intake_item: {
            id: item.id,
            title: item.title,
            category: item.category,
            state: item.state,
          },
          next_action: REVIEW_NEXT_ACTION,
        },
      };
    } catch (err) {
      if (err instanceof IntakeConflictError) {
        return { ok: false, data: { error: "collect_conflict", message: err.message } };
      }
      return {
        ok: false,
        data: {
          error: "collect_failed",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
