import { z } from "@hono/zod-openapi";
import { actorType } from "../../audit/actor.ts";
import { auditAwait } from "../../audit/index.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { assertTaskRunWriter } from "../../conversations/public/lifecycle.ts";
import type { ChatComposerAttachmentRow } from "../../db/schema/index.ts";
import {
  ComposerTrayFullError,
  listComposerTray,
  removeComposerFile,
  removeComposerFiles,
  stageComposerFile,
  type TrayItem,
  type TrayOwner,
} from "../../files/composer-tray.ts";
import { claimSelection } from "../../files/composer-tray-model.ts";
import { conversationExists } from "../../files/service/index.ts";
import { logger } from "../../logging/index.ts";
import { now } from "../../utils/clock.ts";
import {
  AttachmentSchema,
  type AttachmentWire,
  type LinkScope,
  linkToConversation,
  resolveStoredFile,
  type StoredUpload,
  storeUpload,
  toAttachmentWire,
  UploadBody,
} from "./conversation-attachments.ts";
import {
  defineOperation,
  isRejection,
  type OperationScope,
  plainRejection,
  type Rejection,
  reject,
} from "./index.ts";

const COMPOSER_PATH = "/v1/chat/composer/attachments";
const TAGS = ["Conversations"];
const WRITE = { permission: "conversation:write", alternatePermissions: ["workflow:write"] };
const READ = { permission: "conversation:read", alternatePermissions: ["workflow:read"] };

const ComposerAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    file: AttachmentSchema,
    staged_at: z.string().datetime(),
    expires_at: z.string().datetime(),
  })
  .openapi("ComposerAttachment");

const ComposerListResponse = z
  .object({ items: z.array(ComposerAttachmentSchema) })
  .openapi("ComposerAttachmentList");

const ClaimBody = z
  .object({
    conversation_id: z.string().uuid(),
    ids: z
      .array(z.string().uuid())
      .min(1)
      .max(50)
      .optional()
      .describe("Staged attachments to take; all staged ones when left out."),
  })
  .openapi("ComposerAttachmentClaim");

const ClaimResponse = z
  .object({ attachments: z.array(AttachmentSchema) })
  .openapi("ComposerAttachmentClaimResult");

const IdParam = z.object({ id: z.string().uuid() });

type ComposerWire = z.infer<typeof ComposerAttachmentSchema>;
type Upload = z.infer<typeof UploadBody>;
type Claim = z.infer<typeof ClaimBody>;

class ClaimRefused extends Error {
  constructor(readonly rejection: Rejection) {
    super("composer_claim_refused");
    this.name = "ClaimRefused";
  }
}

interface Person {
  readonly principal: ResolvedPrincipal;
  readonly owner: TrayOwner;
  readonly link: LinkScope;
}

function person(scope: OperationScope): Person | Rejection {
  const principal = scope.principal;
  if (!principal) return reject.unauthorized();
  if (principal.kind !== "user")
    return plainRejection(403, "person_required", "Only a person has a chat composer.");
  return {
    principal,
    owner: { tenant_id: scope.tenant_id, user_id: principal.id },
    link: {
      db: scope.db,
      tenant_id: scope.tenant_id,
      principal,
      request_source: scope.request_source ?? "api",
    },
  };
}

function composerWire(entry: ChatComposerAttachmentRow, file: AttachmentWire): ComposerWire {
  return {
    id: entry.id,
    file,
    staged_at: entry.created_at.toISOString(),
    expires_at: entry.expires_at.toISOString(),
  };
}

function itemWire(item: TrayItem): ComposerWire {
  return composerWire(item.entry, toAttachmentWire(item.file, item.entry.slug));
}

async function auditComposer(
  who: Person,
  action:
    | typeof AuditAction.CHAT_COMPOSER_ATTACHMENT_STAGED
    | typeof AuditAction.CHAT_COMPOSER_ATTACHMENT_REMOVED
    | typeof AuditAction.CHAT_COMPOSER_ATTACHMENTS_CLAIMED,
  resource: { type: "file" | "conversation"; id: string },
  metadata: Record<string, unknown>,
): Promise<void> {
  await auditAwait(
    {
      tenant_id: who.owner.tenant_id,
      actor_type: actorType(who.principal),
      actor_id: who.principal.id,
      action,
      resource_type: resource.type,
      resource_id: resource.id,
      result: "success",
      metadata: { ...metadata, request_source: who.link.request_source },
    },
    who.link.db,
  );
}

async function stagedFile(who: Person, body: Upload): Promise<StoredUpload | Rejection> {
  return "$file" in body
    ? resolveStoredFile(who.link, body.$file)
    : storeUpload(who.link, body, "chat_composer");
}

const stage = defineOperation<Upload, ComposerWire>({
  id: "chat.composer.stage",
  summary: "Put a file into your chat composer, to go with your next message",
  ...WRITE,
  effect: "write",
  audit: AuditAction.CHAT_COMPOSER_ATTACHMENT_STAGED,
  async handler(scope, body) {
    const who = person(scope);
    if (isRejection(who)) return who;
    const stored = await stagedFile(who, body);
    if (isRejection(stored)) return stored;
    let entry: ChatComposerAttachmentRow;
    try {
      entry = await stageComposerFile(
        scope.db,
        who.owner,
        { file_id: stored.row.id, slug: stored.slug },
        new Date(now()),
      );
    } catch (error) {
      if (error instanceof ComposerTrayFullError)
        return reject.conflict(
          "The composer already holds the most files it can; send or remove one first.",
          undefined,
          "composer_full",
        );
      throw error;
    }
    await auditComposer(
      who,
      AuditAction.CHAT_COMPOSER_ATTACHMENT_STAGED,
      { type: "file", id: stored.row.id },
      { composer_attachment_id: entry.id, file_id: stored.row.id },
    );
    return composerWire(entry, toAttachmentWire(stored.row, stored.slug));
  },
  http: {
    method: "post",
    path: COMPOSER_PATH,
    tags: TAGS,
    body: UploadBody,
    response: ComposerAttachmentSchema,
    success: { status: 201, description: "Staged" },
    errors: {
      400: "bad_input",
      403: "person_required",
      404: "not_found",
      409: "composer_full",
      413: "too_large",
    },
    toInput: ({ json }) => json as Upload,
    toBody: (wire) => wire,
  },
});

const list = defineOperation<null, { items: ComposerWire[] }>({
  id: "chat.composer.list",
  summary: "Files waiting in your chat composer, newest first",
  ...READ,
  effect: "read",
  async handler(scope) {
    const who = person(scope);
    if (isRejection(who)) return who;
    const items = await listComposerTray(scope.db, who.owner, new Date(now()));
    return { items: items.map(itemWire) };
  },
  http: {
    method: "get",
    path: COMPOSER_PATH,
    tags: TAGS,
    response: ComposerListResponse,
    errors: { 403: "person_required" },
    toInput: () => null,
    toBody: (body) => body,
  },
});

const claim = defineOperation<Claim, { attachments: AttachmentWire[] }>({
  id: "chat.composer.claim",
  summary: "Attach the files waiting in your composer to a conversation",
  ...WRITE,
  effect: "write",
  audit: AuditAction.CHAT_COMPOSER_ATTACHMENTS_CLAIMED,
  async handler(scope, { conversation_id, ids }) {
    const who = person(scope);
    if (isRejection(who)) return who;
    if (!(await conversationExists(scope.db, scope.tenant_id, conversation_id)))
      return plainRejection(404, "not_found", "conversation not found");
    await assertTaskRunWriter(scope.db, {
      tenant_id: scope.tenant_id,
      conversation_id,
      actor_id: who.principal.id,
      principal: who.principal,
    });
    const notWaiting = (missing: readonly string[]) =>
      plainRejection(404, "not_found", "Not every attachment is waiting in your composer.", {
        missing,
      });
    let claimed: TrayItem[];
    try {
      claimed = await scope.db.transaction(async (tx) => {
        const live = await listComposerTray(tx, who.owner, new Date(now()), { lock: true });
        const picked = claimSelection(
          live.map((item) => ({ ...item.entry, item })),
          ids,
        );
        if (!picked.ok) throw new ClaimRefused(notWaiting(picked.missing));
        const wanted = picked.claim.map(({ item }) => item.entry.id);
        const consumed = new Set(await removeComposerFiles(tx, who.owner, wanted));
        const missing = wanted.filter((id) => !consumed.has(id));
        if (missing.length > 0) {
          logger.warn({
            module: "chat_composer",
            action: "claim.race_refused",
            tenant_id: scope.tenant_id,
            conversation_id,
            missing,
          });
          throw new ClaimRefused(notWaiting(missing));
        }
        for (const { item } of picked.claim) {
          const refused = await linkToConversation(
            who.link,
            conversation_id,
            item.file,
            item.entry.slug,
            tx,
          );
          if (refused) throw new ClaimRefused(refused);
        }
        return picked.claim.map(({ item }) => item);
      });
    } catch (error) {
      if (error instanceof ClaimRefused) return error.rejection;
      throw error;
    }
    const attachments = claimed.map((item) => toAttachmentWire(item.file, item.entry.slug));
    await auditComposer(
      who,
      AuditAction.CHAT_COMPOSER_ATTACHMENTS_CLAIMED,
      { type: "conversation", id: conversation_id },
      { file_ids: claimed.map((item) => item.file.id), count: claimed.length },
    );
    return { attachments };
  },
  http: {
    method: "post",
    path: `${COMPOSER_PATH}/claim`,
    tags: TAGS,
    body: ClaimBody,
    response: ClaimResponse,
    errors: { 400: "bad_input", 403: "person_required", 404: "not_found" },
    toInput: ({ json }) => json as Claim,
    toBody: (body) => body,
  },
});

const remove = defineOperation<{ id: string }, true>({
  id: "chat.composer.remove",
  summary: "Take a file out of your chat composer",
  ...WRITE,
  effect: "write",
  audit: AuditAction.CHAT_COMPOSER_ATTACHMENT_REMOVED,
  async handler(scope, { id }) {
    const who = person(scope);
    if (isRejection(who)) return who;
    const removed = await removeComposerFile(scope.db, who.owner, id);
    if (!removed) return plainRejection(404, "not_found", "attachment not found");
    await auditComposer(
      who,
      AuditAction.CHAT_COMPOSER_ATTACHMENT_REMOVED,
      { type: "file", id: removed.file_id },
      { composer_attachment_id: removed.id, file_id: removed.file_id },
    );
    return true;
  },
  http: {
    method: "delete",
    path: `${COMPOSER_PATH}/{id}`,
    tags: TAGS,
    params: IdParam,
    response: z.null(),
    success: { status: 204, description: "Removed" },
    errors: { 403: "person_required", 404: "not_found" },
    toInput: ({ param }) => param as { id: string },
    toBody: () => null,
  },
});

export const chatComposerOperations = { stage, list, claim, remove };
