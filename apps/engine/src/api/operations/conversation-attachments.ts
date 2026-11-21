import { z } from "@hono/zod-openapi";
import { actorType } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { assertTaskRunWriter } from "../../conversations/public/lifecycle.ts";
import type { Db, Executor } from "../../db/client.ts";
import { recordFilesDedupSeen } from "../../files/dedup-counter.ts";
import { FileLinkError, linkStoredFile } from "../../files/links.ts";
import { persistInlineUpload } from "../../files/persist-inline-upload.ts";
import { type FileRow, requireFileForTenant } from "../../files/resolver.ts";
import {
  auditConversationAttachmentStored,
  conversationExists,
  listConversationAttachments,
  unlinkConversationAttachment,
} from "../../files/service/index.ts";
import { fileReference, slugifyFilename } from "../../files/slug.ts";
import {
  isPackageArchive,
  markStoredPackageArchive,
  PACKAGE_CONTENT_TYPE,
} from "../../identity/index.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import {
  FileRefSchema,
  FileSchema,
  type FileWire,
  MAX_INLINE_BYTES,
  parseFileIdOrThrow,
} from "../files-schemas.ts";
import { toFileWire } from "./files-representation.ts";
import { defineOperation, isRejection, plainRejection, type Rejection, reject } from "./index.ts";

const IdParam = z.object({ id: z.string().uuid() });
const SlugParam = z.object({ id: z.string().uuid(), slug: z.string().min(1) });

export const UploadBody = z
  .union([
    FileRefSchema,
    z.object({
      filename: z.string().min(1).max(255),
      content_type: z.string().max(200).optional(),
      content_base64: z.string().min(1),
    }),
  ])
  .openapi("ConversationAttachmentUpload");

export const AttachmentSchema = z
  .object({ ...FileSchema.shape, slug: z.string() })
  .openapi("ConversationAttachment");
export type AttachmentWire = FileWire & { slug: string };

const ListResponse = z
  .object({ attachments: z.array(AttachmentSchema) })
  .openapi("ConversationAttachmentList");

type Upload = z.infer<typeof UploadBody>;

interface IdInput {
  readonly id: string;
}

interface UploadInput extends IdInput {
  readonly body: Upload;
}

interface SlugInput extends IdInput {
  readonly slug: string;
}

export interface LinkScope {
  readonly db: Db;
  readonly tenant_id: string;
  readonly principal: ResolvedPrincipal;
  readonly request_source: RequestSource;
}

const LINKABLE_STATUSES = [
  "pending",
  "uploading",
  "scanning",
  "ready",
  "failed",
  "expired",
] as const;
const CONVERSATION_NOT_FOUND = () => plainRejection(404, "not_found", "conversation not found");

function linkSlug(row: FileRow): string {
  return row.slug ?? slugifyFilename(row.filename);
}

export function toAttachmentWire(row: FileRow, slug: string): AttachmentWire {
  return { ...toFileWire(row), slug, reference: fileReference(slug) };
}

export async function linkToConversation(
  scope: LinkScope,
  conversation_id: string,
  row: FileRow,
  slug: string,
  exec: Executor = scope.db,
): Promise<Rejection | null> {
  return linkStoredFile(
    exec,
    {
      tenant_id: scope.tenant_id,
      file_id: row.id,
      resource_type: "conversation",
      resource_id: conversation_id,
      slug,
      role: "attachment",
    },
    {
      actor_type: actorType(scope.principal),
      actor_id: scope.principal.id,
      request_source: scope.request_source,
      source: "conversation_attachments",
      allowed_statuses: [...LINKABLE_STATUSES],
    },
  ).then(
    () => null,
    (error: unknown) => {
      if (!(error instanceof FileLinkError)) throw error;
      return error.code === "file_unavailable"
        ? plainRejection(404, "not_found", "File is no longer available.")
        : plainRejection(400, "conflict", "Attachment link changed; reload and retry.");
    },
  );
}

async function linkExisting(
  scope: LinkScope,
  conversation_id: string,
  fileRef: string,
): Promise<AttachmentWire | Rejection> {
  const found = await resolveStoredFile(scope, fileRef);
  if (isRejection(found)) return found;
  const refused = await linkToConversation(scope, conversation_id, found.row, found.slug);
  return refused ?? toAttachmentWire(found.row, found.slug);
}

export type InlineUpload = {
  filename: string;
  content_type?: string | undefined;
  content_base64: string;
};

export interface StoredUpload {
  readonly row: FileRow;
  readonly slug: string;
}

export function decodeUpload(content_base64: string): Uint8Array | Rejection {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(content_base64, "base64"));
  } catch {
    return plainRejection(400, "bad_input", "invalid base64");
  }
  if (bytes.byteLength === 0) return plainRejection(400, "bad_input", "empty content");
  if (bytes.byteLength > MAX_INLINE_BYTES) {
    return plainRejection(413, "too_large", `attachment exceeds ${MAX_INLINE_BYTES} bytes cap`);
  }
  return bytes;
}

export async function storeUpload(
  scope: LinkScope,
  body: InlineUpload,
  source: string,
  decoded?: Uint8Array,
): Promise<StoredUpload | Rejection> {
  const filename = body.filename;
  const content_type = body.content_type ?? null;
  const bytes = decoded ?? decodeUpload(body.content_base64);
  if (!(bytes instanceof Uint8Array)) return bytes;
  const isPackage = await isPackageArchive(bytes);
  const stored = await persistInlineUpload(scope.db, {
    tenant_id: scope.tenant_id,
    actor_id: scope.principal.id,
    filename,
    content_type: isPackage ? PACKAGE_CONTENT_TYPE : content_type,
    bytes,
  });
  const { dedup, scan } = stored;
  const row =
    isPackage && stored.row.content_type !== PACKAGE_CONTENT_TYPE
      ? ((await markStoredPackageArchive(scope.db, scope.tenant_id, stored.row.id)) ?? stored.row)
      : stored.row;
  if (dedup) await recordFilesDedupSeen(scope.db, scope.tenant_id);
  await auditConversationAttachmentStored(
    scope.db,
    { principal: scope.principal, request_source: scope.request_source },
    { row, filename, size_bytes: bytes.byteLength, dedup, scan },
    source,
  );
  return { row, slug: linkSlug(row) };
}

export async function resolveStoredFile(
  scope: LinkScope,
  fileRef: string,
): Promise<StoredUpload | Rejection> {
  const fid_uuid = parseFileIdOrThrow(fileRef);
  try {
    const row = await requireFileForTenant(scope.db, scope.tenant_id, fid_uuid);
    return { row, slug: linkSlug(row) };
  } catch {
    return plainRejection(404, "not_found", "file not found");
  }
}

async function storeInline(
  scope: LinkScope,
  conversation_id: string,
  body: InlineUpload,
): Promise<AttachmentWire | Rejection> {
  const stored = await storeUpload(scope, body, "conversation_attachments");
  if (isRejection(stored)) return stored;
  const refused = await linkToConversation(scope, conversation_id, stored.row, stored.slug);
  return refused ?? toAttachmentWire(stored.row, stored.slug);
}

function same<T>(result: T): T {
  return result;
}

const READ = { permission: "conversation:read", alternatePermissions: ["workflow:read"] };
const WRITE = { permission: "conversation:write", alternatePermissions: ["workflow:write"] };

const upload = defineOperation<UploadInput, AttachmentWire>({
  id: "conversation.attachments.upload",
  ...WRITE,
  effect: "write",
  audit: AuditAction.FILE_LINK_ADDED,
  async handler(scope, { id, body }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    if (!(await conversationExists(scope.db, scope.tenant_id, id))) return CONVERSATION_NOT_FOUND();
    await assertTaskRunWriter(scope.db, {
      tenant_id: scope.tenant_id,
      conversation_id: id,
      actor_id: principal.id,
      principal,
    });
    const linkScope: LinkScope = {
      db: scope.db,
      tenant_id: scope.tenant_id,
      principal,
      request_source: scope.request_source ?? "api",
    };
    return "$file" in body
      ? linkExisting(linkScope, id, body.$file)
      : storeInline(linkScope, id, body);
  },
  http: {
    method: "post",
    path: "/v1/conversations/{id}/attachments",
    tags: ["Conversations"],
    params: IdParam,
    body: UploadBody,
    response: AttachmentSchema,
    success: { status: 201, description: "Linked" },
    errors: { 400: "bad_input", 404: "not_found", 413: "too_large" },
    toInput: ({ param, json }) => ({ id: (param as IdInput).id, body: json as Upload }),
    toBody: same,
  },
});

const list = defineOperation<IdInput, { attachments: AttachmentWire[] }>({
  id: "conversation.attachments.list",
  ...READ,
  effect: "read",
  async handler(scope, { id }) {
    if (!(await conversationExists(scope.db, scope.tenant_id, id))) return CONVERSATION_NOT_FOUND();
    const rows = await listConversationAttachments(scope.db, scope.tenant_id, id);
    return {
      attachments: rows.map((r) => toAttachmentWire(r.file, r.link_slug ?? linkSlug(r.file))),
    };
  },
  http: {
    method: "get",
    path: "/v1/conversations/{id}/attachments",
    tags: ["Conversations"],
    params: IdParam,
    response: ListResponse,
    errors: { 404: "not_found" },
    toInput: ({ param }) => ({ id: (param as IdInput).id }),
    toBody: same,
  },
});

const remove = defineOperation<SlugInput, true>({
  id: "conversation.attachments.delete",
  ...WRITE,
  effect: "write",
  audit: AuditAction.FILE_LINK_REMOVED,
  async handler(scope, { id, slug }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    await assertTaskRunWriter(scope.db, {
      tenant_id: scope.tenant_id,
      conversation_id: id,
      actor_id: principal.id,
      principal,
    });
    const unlinked = await unlinkConversationAttachment(
      scope.db,
      { principal, request_source: scope.request_source },
      id,
      slug,
    );
    return unlinked ? true : plainRejection(404, "not_found", "attachment not found");
  },
  http: {
    method: "delete",
    path: "/v1/conversations/{id}/attachments/{slug}",
    tags: ["Conversations"],
    params: SlugParam,
    response: z.null(),
    success: { status: 204, description: "Unlinked" },
    errors: { 404: "not_found" },
    toInput: ({ param }) => param as SlugInput,
    toBody: () => null,
  },
});

export const conversationAttachmentOperations = { upload, list, remove };
