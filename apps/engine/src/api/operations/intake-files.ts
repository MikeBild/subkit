import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { createIntakeItem } from "../../knowledge/intake.ts";
import { checkIntakeFile, INTAKE_FILE_TYPES, intakeFileBody } from "../../knowledge/intake-file.ts";
import type { IntakeItemView } from "../../knowledge/intake-types.ts";
import { CategorySchema } from "../catalog-metadata.ts";
import { MAX_INLINE_BYTES } from "../files-schemas.ts";
import { CapturedAtInputSchema } from "../intake-schemas.ts";
import { decodeUpload, storeUpload } from "./conversation-attachments.ts";
import { defineOperation, isRejection, reject } from "./index.ts";
import { INTAKE_TAGS, INTAKE_WRITE, intakeCaller, intakeFailure } from "./intake.ts";
import { ItemSchema } from "./intake-representation.ts";

const CreateFileItemSchema = z
  .object({
    client_request_id: z.string().uuid(),
    category: CategorySchema.optional(),
    title: z.string().trim().min(1).max(1_000).optional(),
    note: z.string().max(20_000).optional(),
    captured_at: CapturedAtInputSchema,
    filename: z.string().trim().min(1).max(255),
    content_type: z
      .string()
      .min(1)
      .max(200)
      .describe(`One of: ${Object.keys(INTAKE_FILE_TYPES).join(", ")}.`),
    content_base64: z.string().min(1).describe(`At most ${MAX_INLINE_BYTES} bytes once decoded.`),
  })
  .openapi("CreateIntakeFileItem");

type CreateFileItem = z.infer<typeof CreateFileItemSchema>;

export const createIntakeFileItemOperation = defineOperation<CreateFileItem, IntakeItemView>({
  id: "intake.create_file_item",
  summary: "Collect a file (PDF, image, CSV, text, Markdown or JSON) into the inbox",
  permission: INTAKE_WRITE,
  effect: "write",
  audit: AuditAction.INTAKE_ITEM_COLLECTED,
  async handler(scope, body) {
    const caller = intakeCaller(scope);
    if (isRejection(caller)) return caller;
    const bytes = decodeUpload(body.content_base64);
    if (!(bytes instanceof Uint8Array)) return bytes;
    const checked = checkIntakeFile(body.content_type, bytes);
    if (!checked.ok)
      return reject.unprocessable(
        checked.reason === "unsupported_file_type"
          ? `Only these files can go into the inbox: ${Object.keys(INTAKE_FILE_TYPES).join(", ")}.`
          : "The file content does not match its type.",
        undefined,
        checked.reason,
      );
    const stored = await storeUpload(
      {
        db: scope.db,
        tenant_id: scope.tenant_id,
        principal: caller.principal,
        request_source: scope.request_source ?? "api",
      },
      {
        filename: body.filename,
        content_type: checked.content_type,
        content_base64: body.content_base64,
      },
      "intake",
      bytes,
    );
    if (isRejection(stored)) return stored;
    if (stored.row.status === "failed")
      return reject.unprocessable(
        "The file did not pass the malware check and was not collected.",
        undefined,
        "file_rejected",
      );
    const attachment = {
      file_id: stored.row.id,
      filename: body.filename,
      content_type: checked.content_type,
      size_bytes: bytes.byteLength,
    };
    try {
      return await createIntakeItem(
        {
          tenant_id: scope.tenant_id,
          actor: caller.actor,
          client_request_id: body.client_request_id,
          category: body.category,
          title: body.title ?? body.filename,
          captured_at: body.captured_at,
          body: intakeFileBody(attachment, checked.text),
          note: body.note,
          attachment,
        },
        scope.db,
      );
    } catch (error) {
      return intakeFailure(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/intake/items/file",
    tags: INTAKE_TAGS,
    body: CreateFileItemSchema,
    response: ItemSchema,
    success: { status: 201, description: "Created" },
    errors: {
      400: "bad_input",
      409: "Conflict",
      413: "too_large",
      422: "unsupported_file_type, content_type_mismatch or file_rejected",
    },
    toInput: ({ json }) => json as CreateFileItem,
    toBody: (item) => item,
  },
});
