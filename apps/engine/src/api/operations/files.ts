import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import {
  deleteFile,
  type FileActor,
  fileStats,
  fileUsage,
  findLiveFile,
  findTenantFile,
  getFileDetail,
  linkFile,
  listFiles,
  replaceFileBytes,
  restoreFileVersion,
  updateFileDetails,
} from "../../files/service/index.ts";
import { listFileVersions } from "../../files/versions.ts";
import { getContext } from "../../logging/context.ts";
import { RequestSourceSchema } from "../../observability/service-metadata.ts";
import {
  FILE_VERSION_RETENTION,
  FileLinkSchema,
  type FileLinkWire,
  FileListResponseSchema,
  FileSchema,
  FileStatsSchema,
  FileUsageSchema,
  FileVersionListSchema,
  type InlineUpload,
  InlineUploadSchema,
  type LinkRequest,
  LinkRequestSchema,
  type ListFilesQuery,
  ListFilesQuerySchema,
  MAX_INLINE_BYTES,
  parseFileIdOrThrow,
  toFileId,
  UpdateFileSchema,
} from "../files-schemas.ts";
import { FileIdParam, FileVersionParam, toFileWire } from "./files-representation.ts";
import { defineOperation, type OperationScope, plainRejection, reject } from "./index.ts";

const TAGS = ["Files"] as const;
const READ = { permission: "file:read", alternatePermissions: [] } as const;

type UpdateFile = z.infer<typeof UpdateFileSchema>;
type FileListPage = Awaited<ReturnType<typeof listFiles>>;
type FileDetail = NonNullable<Awaited<ReturnType<typeof getFileDetail>>>;
type FileRow = NonNullable<Awaited<ReturnType<typeof findTenantFile>>>;
type LinkOutcome = Awaited<ReturnType<typeof linkFile>>;
type LinkedRow = Extract<LinkOutcome, { kind: "linked" }>["link"];

const fileNotFound = () => plainRejection(404, "not_found", "file not found");

function fileUuidOf(param: unknown): string {
  return parseFileIdOrThrow((param as { id: string }).id);
}

function fileActorOf(scope: OperationScope): FileActor | null {
  if (!scope.principal) return null;
  const source = RequestSourceSchema.safeParse(getContext().request_source);
  return { principal: scope.principal, request_source: source.success ? source.data : undefined };
}

export const listFilesOperation = defineOperation<ListFilesQuery, FileListPage>({
  id: "files.list",
  ...READ,
  effect: "read",
  handler: (scope, query) => listFiles(scope.db, scope.tenant_id, query),
  http: {
    method: "get",
    path: "/v1/files",
    tags: TAGS,
    query: ListFilesQuerySchema,
    response: FileListResponseSchema,
    toInput: ({ query }) => query as ListFilesQuery,
    toBody: (page) => ({
      items: page.entries.map(({ row, creator, usage }) => ({
        ...toFileWire(row),
        creator,
        usage,
      })),
      total: page.total,
      next_cursor: page.next_cursor,
    }),
  },
});

export const fileStatsOperation = defineOperation<null, Awaited<ReturnType<typeof fileStats>>>({
  id: "files.stats",
  ...READ,
  effect: "read",
  handler: (scope) => fileStats(scope.db, scope.tenant_id),
  http: {
    method: "get",
    path: "/v1/files/stats",
    tags: TAGS,
    response: FileStatsSchema,
    toInput: () => null,
    toBody: (stats) => stats,
  },
});

export const getFileOperation = defineOperation<string, FileDetail>({
  id: "files.get",
  ...READ,
  effect: "read",
  async handler(scope, fileUuid) {
    if (!scope.principal) return reject.unauthorized();
    return (await getFileDetail(scope.db, scope.principal, fileUuid)) ?? fileNotFound();
  },
  http: {
    method: "get",
    path: "/v1/files/{id}",
    tags: TAGS,
    params: FileIdParam,
    response: FileSchema,
    errors: { 404: "not_found" },
    toInput: ({ param }) => fileUuidOf(param),
    toBody: (detail) => ({
      ...toFileWire(detail.row),
      creator: detail.creator,
      creator_name: detail.creator_name,
      creator_api_key_name: detail.creator_api_key_name,
    }),
  },
});

export const deleteFileOperation = defineOperation<string, "deleted">({
  id: "files.delete",
  permission: "file:delete",
  alternatePermissions: [],
  effect: "write",
  audit: AuditAction.FILE_DELETED,
  async handler(scope, fileUuid) {
    const actor = fileActorOf(scope);
    if (!actor) return reject.unauthorized();
    const outcome = await deleteFile(scope.db, actor, fileUuid);
    return outcome === "not_found" ? fileNotFound() : outcome;
  },
  http: {
    method: "delete",
    path: "/v1/files/{id}",
    tags: TAGS,
    params: FileIdParam,
    response: z.null(),
    success: { status: 204, description: "Deleted" },
    errors: { 404: "not_found" },
    toInput: ({ param }) => fileUuidOf(param),
    toBody: () => null,
  },
});

interface LinkInput {
  readonly fileUuid: string;
  readonly body: LinkRequest;
}

export const linkFileOperation = defineOperation<LinkInput, LinkedRow>({
  id: "files.link",
  permission: "file:write",
  alternatePermissions: [],
  effect: "write",
  audit: AuditAction.FILE_LINK_ADDED,
  async handler(scope, { fileUuid, body }) {
    const actor = fileActorOf(scope);
    if (!actor) return reject.unauthorized();
    const outcome = await linkFile(scope.db, actor, fileUuid, body);
    if (outcome.kind === "not_found") return fileNotFound();
    if (outcome.kind === "not_ready")
      return plainRejection(
        409,
        "file_not_ready",
        `cannot link file in status=${outcome.status}; wait for finalize`,
        { status: outcome.status },
      );
    if (outcome.kind === "link_changed")
      return plainRejection(409, outcome.code, "File link changed; reload and retry.");
    return outcome.link;
  },
  http: {
    method: "post",
    path: "/v1/files/{id}/links",
    tags: TAGS,
    params: FileIdParam,
    body: LinkRequestSchema,
    response: FileLinkSchema,
    success: { status: 201, description: "Linked" },
    errors: { 404: "not_found", 409: "conflict" },
    toInput: ({ param, json }) => ({ fileUuid: fileUuidOf(param), body: json as LinkRequest }),
    toBody: (link): FileLinkWire => ({
      id: link.id,
      file_id: toFileId(link.file_id),
      resource_type: link.resource_type,
      resource_id: link.resource_id,
      slug: link.slug,
      role: link.role,
      created_at: link.created_at.toISOString(),
    }),
  },
});

interface RenameInput {
  readonly fileUuid: string;
  readonly body: UpdateFile;
}

export const renameFileOperation = defineOperation<RenameInput, FileRow>({
  id: "files.rename",
  permission: "file:write",
  alternatePermissions: [],
  effect: "write",
  audit: AuditAction.FILE_RENAMED,
  async handler(scope, { fileUuid, body }) {
    const actor = fileActorOf(scope);
    if (!actor) return reject.unauthorized();
    return (await updateFileDetails(scope.db, actor, fileUuid, body)) ?? fileNotFound();
  },
  http: {
    method: "patch",
    path: "/v1/files/{id}",
    tags: TAGS,
    params: FileIdParam,
    body: UpdateFileSchema,
    response: FileSchema,
    success: { status: 200, description: "Updated" },
    errors: {
      400: "Invalid description acceptance",
      404: "not_found",
      409: "The reviewed description changed",
    },
    toInput: ({ param, json }) => ({ fileUuid: fileUuidOf(param), body: json as UpdateFile }),
    toBody: (row) => toFileWire(row),
  },
});

interface ReplaceInput {
  readonly fileUuid: string;
  readonly body: InlineUpload;
}

interface RestoreInput {
  readonly fileUuid: string;
  readonly version: number;
}

function duplicateContent(twinId: string) {
  return plainRejection(
    409,
    "duplicate_content",
    "another stored file already has exactly this content",
    { hint: `Use the existing file ${toFileId(twinId)} instead.` },
  );
}

export const replaceFileOperation = defineOperation<ReplaceInput, FileRow>({
  id: "files.replace",
  permission: "file:write",
  alternatePermissions: [],
  effect: "write",
  audit: AuditAction.FILE_REPLACED,
  async handler(scope, { fileUuid, body }) {
    const actor = fileActorOf(scope);
    if (!actor) return reject.unauthorized();
    const row = await findLiveFile(scope.db, scope.tenant_id, fileUuid);
    if (!row) return fileNotFound();
    const bytes = Uint8Array.from(Buffer.from(body.content_base64, "base64"));
    if (bytes.byteLength === 0) return plainRejection(400, "bad_input", "empty content");
    if (bytes.byteLength > MAX_INLINE_BYTES)
      return plainRejection(413, "too_large", `replacement exceeds ${MAX_INLINE_BYTES} bytes cap`);
    const result = await replaceFileBytes(scope.db, actor, row, {
      filename: body.filename,
      content_type: body.content_type ?? null,
      bytes,
    });
    if (result.kind === "scan_rejected")
      return plainRejection(
        422,
        "scan_rejected",
        result.verdict === "timeout"
          ? "the content could not be checked in time; nothing was replaced"
          : "the content did not pass the scan; nothing was replaced",
      );
    if (result.kind === "duplicate") return duplicateContent(result.twinId);
    if (result.kind === "not_found") return fileNotFound();
    return result.row;
  },
  http: {
    method: "post",
    path: "/v1/files/{id}/replace",
    tags: TAGS,
    params: FileIdParam,
    body: InlineUploadSchema,
    response: FileSchema,
    success: {
      status: 200,
      description: "Replaced; the id and every reference to it are unchanged",
    },
    errors: {
      400: "bad_input",
      404: "not_found",
      409: "duplicate_content",
      413: "too_large",
      422: "scan_rejected",
    },
    toInput: ({ param, json }) => ({ fileUuid: fileUuidOf(param), body: json as InlineUpload }),
    toBody: (row) => toFileWire(row),
  },
});

export const listFileVersionsOperation = defineOperation<
  string,
  Awaited<ReturnType<typeof listFileVersions>>
>({
  id: "files.list_versions",
  summary: "List a file's content versions, newest first",
  ...READ,
  effect: "read",
  async handler(scope, fileUuid) {
    const row = await findLiveFile(scope.db, scope.tenant_id, fileUuid);
    if (!row) return fileNotFound();
    return listFileVersions(scope.db, scope.tenant_id, row);
  },
  http: {
    method: "get",
    path: "/v1/files/{id}/versions",
    tags: TAGS,
    description: `The current content and every earlier content kept after a replace or restore, newest first. \`current\` marks the content the file serves now. The newest ${FILE_VERSION_RETENTION} earlier versions are kept; deleting the file removes all of them.`,
    params: FileIdParam,
    response: FileVersionListSchema,
    errors: { 404: "not_found" },
    toInput: ({ param }) => fileUuidOf(param),
    toBody: (items) => ({ items }),
  },
});

export const restoreFileVersionOperation = defineOperation<RestoreInput, FileRow>({
  id: "files.restore_version",
  summary: "Make an earlier content version the file's content again",
  permission: "file:write",
  alternatePermissions: [],
  effect: "write",
  audit: AuditAction.FILE_REPLACED,
  async handler(scope, { fileUuid, version }) {
    const actor = fileActorOf(scope);
    if (!actor) return reject.unauthorized();
    const row = await findLiveFile(scope.db, scope.tenant_id, fileUuid);
    if (!row) return fileNotFound();
    const result = await restoreFileVersion(scope.db, actor, row, version);
    if (result.kind === "current_version")
      return plainRejection(
        409,
        "current_version",
        `version ${version} is already the current content`,
      );
    if (result.kind === "version_not_found")
      return plainRejection(404, "not_found", "file version not found");
    if (result.kind === "duplicate") return duplicateContent(result.twinId);
    if (result.kind === "not_found") return fileNotFound();
    return result.row;
  },
  http: {
    method: "post",
    path: "/v1/files/{id}/versions/{version}/restore",
    tags: TAGS,
    description:
      "Restores the content of an earlier version as a new version. The content it replaces stays in the history, so a restore can be undone the same way. The id and every reference stay unchanged.",
    params: FileVersionParam,
    response: FileSchema,
    success: { status: 200, description: "Restored as the newest version" },
    errors: { 404: "not_found", 409: "duplicate_content or current_version" },
    toInput: ({ param }) => ({
      fileUuid: fileUuidOf(param),
      version: (param as { version: number }).version,
    }),
    toBody: (row) => toFileWire(row),
  },
});

export const fileUsageOperation = defineOperation<string, Awaited<ReturnType<typeof fileUsage>>>({
  id: "files.usage",
  ...READ,
  effect: "read",
  async handler(scope, fileUuid) {
    if (!scope.principal) return reject.unauthorized();
    const row = await findTenantFile(scope.db, scope.tenant_id, fileUuid);
    if (!row) return fileNotFound();
    return fileUsage(scope.db, scope.principal, row);
  },
  http: {
    method: "get",
    path: "/v1/files/{id}/usage",
    tags: TAGS,
    params: FileIdParam,
    response: FileUsageSchema,
    errors: { 404: "not_found" },
    toInput: ({ param }) => fileUuidOf(param),
    toBody: (usage) => usage,
  },
});
