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
  updateFileDetails,
} from "../../files/service.ts";
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
  type LinkRequest,
  LinkRequestSchema,
  type ListFilesQuery,
  ListFilesQuerySchema,
  parseFileIdOrThrow,
  toFileId,
  UpdateFileSchema,
} from "../files-schemas.ts";
import { FileIdParam, toFileWire } from "./files-representation.ts";
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
