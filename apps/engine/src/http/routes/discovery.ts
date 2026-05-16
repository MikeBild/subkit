// Discovery HTTP surface (programmatic / SDK access).
//
// The primary UX is conversational (file attachments + start_connector_from_*/
// propose_skill tools). These endpoints exist for SDK consumers and admin
// tooling that prefer batch file analysis.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import * as svc from "../../discovery/index.ts";
import {
  DiscoveryArtifactSchema,
  DiscoveryRunSchema,
  extractCodebaseArchive,
} from "../../discovery/index.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const RunIdParam = z.object({ id: z.string().uuid() });
const ArtifactIdParam = z.object({ id: z.string().uuid() });

const DiscoveryRunListResponse = z
  .object({ items: z.array(DiscoveryRunSchema) })
  .openapi("DiscoveryRunListResponse");

const DiscoveryArtifactListResponse = z
  .object({ items: z.array(DiscoveryArtifactSchema) })
  .openapi("DiscoveryArtifactListResponse");

const listRunsRoute = createRoute({
  method: "get",
  path: "/v1/discovery/runs",
  tags: ["discovery"],
  summary: "List discovery runs",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        status: z.enum(["pending", "analyzing", "synthesizing", "completed", "failed"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .openapi("ListDiscoveryRunsQuery"),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: DiscoveryRunListResponse } },
    },
  },
});

const getRunRoute = createRoute({
  method: "get",
  path: "/v1/discovery/runs/{id}",
  tags: ["discovery"],
  summary: "Get a discovery run",
  security: [{ bearerAuth: [] }],
  request: { params: RunIdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: DiscoveryRunSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listArtifactsRoute = createRoute({
  method: "get",
  path: "/v1/discovery/runs/{id}/artifacts",
  tags: ["discovery"],
  summary: "List artifacts for a discovery run",
  security: [{ bearerAuth: [] }],
  request: {
    params: RunIdParam,
    query: z
      .object({
        kind: z.enum(["connector", "skill", "knowledge_source"]).optional(),
        status: z.enum(["proposed", "approved", "rejected", "superseded"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .openapi("ListDiscoveryArtifactsQuery"),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: DiscoveryArtifactListResponse } },
    },
  },
});

const getArtifactRoute = createRoute({
  method: "get",
  path: "/v1/discovery/artifacts/{id}",
  tags: ["discovery"],
  summary: "Get a discovery artifact",
  security: [{ bearerAuth: [] }],
  request: { params: ArtifactIdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: DiscoveryArtifactSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const approveArtifactRoute = createRoute({
  method: "post",
  path: "/v1/discovery/artifacts/{id}/approve",
  tags: ["discovery"],
  summary: "Approve a discovery artifact",
  security: [{ bearerAuth: [] }],
  request: { params: ArtifactIdParam },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z
            .object({
              approved: z.boolean(),
              materialized_id: z.string().nullable(),
              materialized_type: z.string().nullable(),
            })
            .openapi("ApproveDiscoveryArtifactResponse"),
        },
      },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const rejectArtifactRoute = createRoute({
  method: "post",
  path: "/v1/discovery/artifacts/{id}/reject",
  tags: ["discovery"],
  summary: "Reject a discovery artifact",
  security: [{ bearerAuth: [] }],
  request: {
    params: ArtifactIdParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ reason: z.string().optional() })
            .openapi("RejectDiscoveryArtifactBody"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ rejected: z.boolean() }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerDiscoveryRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/discovery/*", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("discovery:read")(c, next);
    return requirePermission("discovery:approve")(c, next);
  });

  app.openapi(listRunsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const items = await svc.listDiscoveryRuns(
      {
        tenant_id: principal.tenant_id,
        ...(q.status ? { status: q.status } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      db,
    );
    return c.json({ items }, 200);
  });

  app.openapi(getRunRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const run = await svc.getDiscoveryRun(principal.tenant_id, id, db);
    if (!run) throw new NotFoundError("discovery_run");
    return c.json(run, 200);
  });

  app.openapi(listArtifactsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const items = await svc.listDiscoveryArtifacts(
      {
        tenant_id: principal.tenant_id,
        run_id: id,
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      db,
    );
    return c.json({ items }, 200);
  });

  app.openapi(getArtifactRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const artifact = await svc.getDiscoveryArtifact(principal.tenant_id, id, db);
    if (!artifact) throw new NotFoundError("discovery_artifact");
    return c.json(artifact, 200);
  });

  app.openapi(approveArtifactRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const result = await svc.approveDiscoveryArtifact(
      { tenant_id: principal.tenant_id, artifact_id: id, actor_id: principal.id },
      db,
    );
    if (!result) throw new NotFoundError("discovery_artifact");
    return c.json({ approved: true, ...result }, 200);
  });

  app.openapi(rejectArtifactRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const rejected = await svc.rejectDiscoveryArtifact(
      {
        tenant_id: principal.tenant_id,
        artifact_id: id,
        actor_id: principal.id,
        ...(body.reason ? { reason: body.reason } : {}),
      },
      db,
    );
    if (!rejected) throw new NotFoundError("discovery_artifact");
    return c.json({ rejected: true }, 200);
  });

  // Multipart upload route for creating discovery runs
  app.post("/v1/discovery/runs", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");

    const formData = await c.req.formData();
    const label = formData.get("label");
    const files = formData.getAll("files");

    if (files.length === 0) {
      return c.json({ error: "at least one file is required" }, 400);
    }
    if (files.length > 50) {
      return c.json({ error: "maximum 50 files per run" }, 400);
    }

    const parsedFiles: Array<{ buffer: Buffer; filename: string; mime?: string }> = [];
    for (const file of files) {
      if (!(file instanceof File)) continue;
      const buffer = Buffer.from(await file.arrayBuffer());
      parsedFiles.push({
        buffer,
        filename: file.name,
        ...(file.type ? { mime: file.type } : {}),
      });
    }

    const run = await svc.createDiscoveryRun(
      {
        tenant_id: principal.tenant_id,
        files: parsedFiles,
        actor_id: principal.id,
        ...(typeof label === "string" ? { label } : {}),
      },
      db,
    );

    return c.json(run, 202);
  });

  // Codebase-archive upload. Accepts a zip and extracts its contents
  // into a discovery run. Filters out binaries, generated dirs, and
  // lockfiles so the LLM only sees semantically interesting files.
  //
  // TODO(files): C20 — route through /v1/files/inline + fid. The archive
  // should be uploaded via POST /v1/files/inline first; the route should
  // then accept a `fid` param and produce `files` + `file_links(resource_type
  // ='discovery_run')` rows instead of consuming the multipart buffer
  // in-process. See apps/engine/src/discovery/tests/analyze-archive-via-files-inline.test.ts.
  app.post("/v1/discovery/runs/from-archive", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");

    const formData = await c.req.formData();
    const label = formData.get("label");
    const archive = formData.get("archive");

    if (!(archive instanceof File)) {
      return c.json({ error: "multipart 'archive' file is required" }, 400);
    }
    const archiveBuffer = Buffer.from(await archive.arrayBuffer());
    if (archiveBuffer.byteLength > 100 * 1024 * 1024) {
      return c.json({ error: "archive exceeds 100MB limit" }, 413);
    }

    let extracted: Awaited<ReturnType<typeof extractCodebaseArchive>>;
    try {
      extracted = await extractCodebaseArchive(archiveBuffer);
    } catch (err) {
      return c.json(
        { error: `archive extraction failed: ${err instanceof Error ? err.message : String(err)}` },
        400,
      );
    }
    if (extracted.files.length === 0) {
      return c.json(
        {
          error:
            "no analysable files found after filtering (all entries were binaries, lockfiles, or generated artifacts)",
          skipped_reasons: extracted.skipped_reasons,
        },
        400,
      );
    }

    const run = await svc.createDiscoveryRun(
      {
        tenant_id: principal.tenant_id,
        files: extracted.files,
        actor_id: principal.id,
        ...(typeof label === "string" ? { label } : {}),
      },
      db,
    );

    return c.json(
      {
        ...run,
        archive_stats: {
          extracted_count: extracted.files.length,
          skipped_count: extracted.skipped_count,
          skipped_reasons: extracted.skipped_reasons,
          total_bytes: extracted.total_bytes,
          truncated: extracted.truncated,
        },
      },
      202,
    );
  });
}
