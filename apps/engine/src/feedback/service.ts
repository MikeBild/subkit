import { and, eq } from "drizzle-orm";
import type { Actor } from "../audit/actor.ts";
import { auditActor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { intakeItems } from "../db/schema/intake.ts";
import { persistInlineUpload } from "../files/persist-inline-upload.ts";
import { removeStoredFile } from "../files/remove-stored-file.ts";
import { createIntakeItem } from "../knowledge/intake.ts";
import {
  classifyFeedbackFile,
  decodeBase64,
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  FEEDBACK_MAX_SCREENSHOT_BYTES,
  FEEDBACK_SCREENSHOT_NAME,
} from "./core/attachments.ts";
import {
  type FeedbackDiagnostics,
  redactFeedbackDiagnostics,
  redactFeedbackFileName,
  redactFeedbackText,
} from "./core/redaction.ts";
import {
  FEEDBACK_CATEGORY,
  type FeedbackKind,
  feedbackBody,
  feedbackTitle,
  type StoredFeedbackFile,
} from "./core/report.ts";

export type FeedbackRefusal =
  | "attachment_invalid"
  | "attachment_too_large"
  | "attachment_type"
  | "attachment_rejected"
  | "screenshot_invalid"
  | "screenshot_too_large"
  | "report_id_taken";

export class FeedbackRefusedError extends Error {
  constructor(
    readonly reason: FeedbackRefusal,
    readonly filename: string | null = null,
  ) {
    super(reason);
    this.name = "FeedbackRefusedError";
  }
}

export interface SubmitFeedbackParams {
  readonly tenant_id: string;
  readonly actor: Actor;
  readonly report_id: string;
  readonly kind: FeedbackKind;
  readonly message: string;
  readonly diagnostics?: FeedbackDiagnostics | undefined;
  readonly attachments?:
    | readonly { readonly filename: string; readonly content_base64: string }[]
    | undefined;
  readonly screenshot_png_base64?: string | undefined;
  readonly now: Date;
  readonly created_on_device_at?: Date | undefined;
}

export interface SubmittedFeedback {
  readonly id: string;
  readonly intake_item_id: string;
  readonly replayed: boolean;
}

export const DEVICE_CLOCK_AHEAD_MS = 5 * 60_000;
export const DEVICE_QUEUE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export function capturedOnDevice(device: Date | undefined, now: Date): Date {
  if (!device || Number.isNaN(device.getTime())) return now;
  const age = now.getTime() - device.getTime();
  if (age < -DEVICE_CLOCK_AHEAD_MS || age > DEVICE_QUEUE_MAX_AGE_MS) return now;
  return device.getTime() > now.getTime() ? now : device;
}

interface PreparedFile {
  readonly filename: string;
  readonly content_type: string;
  readonly bytes: Uint8Array;
}

function prepareAttachment(
  input: { filename: string; content_base64: string },
  count: (removed: number) => void,
): PreparedFile {
  const filename = redactFeedbackFileName(input.filename);
  const bytes = decodeBase64(input.content_base64);
  if (!bytes || bytes.byteLength === 0)
    throw new FeedbackRefusedError("attachment_invalid", filename);
  if (bytes.byteLength > FEEDBACK_MAX_ATTACHMENT_BYTES)
    throw new FeedbackRefusedError("attachment_too_large", filename);
  const kind = classifyFeedbackFile(input.filename, bytes);
  if (!kind) throw new FeedbackRefusedError("attachment_type", filename);
  if (kind.text === null) return { filename, content_type: kind.content_type, bytes };
  const cleaned = redactFeedbackText(kind.text, { emails: true });
  count(cleaned.count);
  return {
    filename,
    content_type: kind.content_type,
    bytes: new TextEncoder().encode(cleaned.value),
  };
}

function prepareScreenshot(content_base64: string): PreparedFile {
  const bytes = decodeBase64(content_base64);
  if (!bytes || !classifyFeedbackFile(FEEDBACK_SCREENSHOT_NAME, bytes))
    throw new FeedbackRefusedError("screenshot_invalid");
  if (bytes.byteLength > FEEDBACK_MAX_SCREENSHOT_BYTES)
    throw new FeedbackRefusedError("screenshot_too_large");
  return { filename: FEEDBACK_SCREENSHOT_NAME, content_type: "image/png", bytes };
}

export async function existingReport(
  db: Db,
  p: Pick<SubmitFeedbackParams, "tenant_id" | "actor" | "report_id">,
): Promise<SubmittedFeedback | null> {
  const [row] = await db
    .select({
      id: intakeItems.id,
      category: intakeItems.category,
      collected_by_id: intakeItems.collected_by_id,
    })
    .from(intakeItems)
    .where(
      and(eq(intakeItems.tenant_id, p.tenant_id), eq(intakeItems.client_request_id, p.report_id)),
    )
    .limit(1);
  if (!row) return null;
  if (row.category !== FEEDBACK_CATEGORY || row.collected_by_id !== p.actor.id)
    throw new FeedbackRefusedError("report_id_taken");
  return { id: p.report_id, intake_item_id: row.id, replayed: true };
}

export async function submitFeedback(db: Db, p: SubmitFeedbackParams): Promise<SubmittedFeedback> {
  const replay = await existingReport(db, p);
  if (replay) return replay;
  let redactions = 0;
  const count = (removed: number) => {
    redactions += removed;
  };
  const message = redactFeedbackText(p.message);
  count(message.count);
  const diagnostics = p.diagnostics ? redactFeedbackDiagnostics(p.diagnostics) : null;
  count(diagnostics?.count ?? 0);
  const prepared = (p.attachments ?? []).map((attachment) => prepareAttachment(attachment, count));
  if (p.screenshot_png_base64) prepared.push(prepareScreenshot(p.screenshot_png_base64));

  const stored: StoredFeedbackFile[] = [];
  const created: string[] = [];
  try {
    for (const file of prepared) {
      const result = await persistInlineUpload(db, {
        tenant_id: p.tenant_id,
        actor_id: p.actor.id,
        filename: file.filename,
        content_type: file.content_type,
        bytes: file.bytes,
      });
      if (!result.dedup) created.push(result.row.id);
      if (result.row.status === "failed")
        throw new FeedbackRefusedError("attachment_rejected", file.filename);
      stored.push({
        id: result.row.id,
        filename: file.filename,
        content_type: file.content_type,
        size_bytes: file.bytes.byteLength,
      });
    }
    return await db.transaction(async (tx) => {
      const item = await createIntakeItem(
        {
          tenant_id: p.tenant_id,
          actor: p.actor,
          client_request_id: p.report_id,
          category: FEEDBACK_CATEGORY,
          title: feedbackTitle(p.kind, message.value),
          captured_at: capturedOnDevice(p.created_on_device_at, p.now).toISOString(),
          body: feedbackBody({
            report_id: p.report_id,
            kind: p.kind,
            message: message.value,
            diagnostics: diagnostics?.value ?? null,
            files: stored,
            redactions,
          }),
        },
        tx,
      );
      await auditAwait(
        {
          tenant_id: p.tenant_id,
          ...auditActor(p.actor),
          action: AuditAction.FEEDBACK_SUBMITTED,
          resource_type: "intake_item",
          resource_id: item.id,
          result: "success",
          metadata: {
            kind: p.kind,
            report_id: p.report_id,
            category: FEEDBACK_CATEGORY,
            client_kind: diagnostics?.value.client_kind ?? null,
            diagnostics: diagnostics !== null,
            attachments: p.attachments?.length ?? 0,
            screenshot: Boolean(p.screenshot_png_base64),
            file_ids: stored.map((file) => file.id),
            redactions,
            created_on_device_at: p.created_on_device_at?.toISOString() ?? null,
          },
        },
        tx,
      );
      return { id: p.report_id, intake_item_id: item.id, replayed: false };
    });
  } catch (error) {
    for (const id of created) await removeStoredFile(db, p.tenant_id, id).catch(() => {});
    throw error;
  }
}
