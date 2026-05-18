// Integration test: fork a conversation that has file attachments.
//
// Asserts:
//   1. `file_links` rows are duplicated for the forked conversation.
//   2. Both forked link rows point at the same `files.id`s as the source.
//   3. The cleanup cron does NOT reap files that are referenced by either
//      side (soft-delete unlinked sweep skips them).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  conversationMessages,
  conversations,
  fileLinks,
  files,
} from "../../db/schema/index.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { runFilesCleanup } from "../../scheduler/files-cleanup-runner.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { forkConversation } from "./fork.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("snapshot-fork-files");
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

describe("forkConversation + file_links", () => {
  test("forked conversation gets duplicate file_links pointing at same file ids", async () => {
    const [conv] = await srv.db
      .insert(conversations)
      .values({ tenant_id: srv.tenantId, status: "active", title: "source-conv" })
      .returning();
    const conversation_id = conv!.id;

    const att1 = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "doc1.txt",
      content: "doc1-content",
      slug: "fork-doc1",
    });
    const att2 = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "doc2.txt",
      content: "doc2-content",
      slug: "fork-doc2",
    });

    const [msg] = await srv.db
      .insert(conversationMessages)
      .values({
        tenant_id: srv.tenantId,
        conversation_id,
        role: "user",
        content: { text: "hello" },
      })
      .returning();
    const anchor_message_id = msg!.id;

    const result = await forkConversation(
      {
        tenant_id: srv.tenantId,
        source_conversation_id: conversation_id,
        anchor_message_id,
        actor_id: null,
        actor_type: "system",
        request_source: "api",
      },
      srv.db,
    );
    expect(result).not.toBeNull();
    const forkedConvId = result!.conversation.id;

    // Both source link file_uuids must appear in forked conv links
    const forkLinks = await srv.db
      .select({ file_id: fileLinks.file_id, slug: fileLinks.slug })
      .from(fileLinks)
      .where(
        and(
          eq(fileLinks.tenant_id, srv.tenantId),
          eq(fileLinks.resource_type, "conversation"),
          eq(fileLinks.resource_id, forkedConvId),
        ),
      );
    const forkFileIds = forkLinks.map((l) => l.file_id);
    expect(forkFileIds).toContain(att1.file_uuid);
    expect(forkFileIds).toContain(att2.file_uuid);
    expect(forkFileIds).toHaveLength(2);

    // The link slugs are preserved
    const slugs = forkLinks.map((l) => l.slug);
    expect(slugs).toContain("fork-doc1");
    expect(slugs).toContain("fork-doc2");

    // FILE_LINK_ADDED audit rows for the fork
    const auditRows = await srv.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, srv.tenantId), eq(auditLog.action, "file.link_added")));
    const forkAuditRows = auditRows.filter(
      (r) => (r.metadata as Record<string, unknown>).source === "fork",
    );
    expect(forkAuditRows.length).toBeGreaterThanOrEqual(2);
  });

  test("cleanup cron does NOT reap files referenced by either side of a fork", async () => {
    const [conv] = await srv.db
      .insert(conversations)
      .values({ tenant_id: srv.tenantId, status: "active", title: "cron-test-source" })
      .returning();
    const conversation_id = conv!.id;

    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "cron-guard.txt",
      content: "cron-guard-bytes",
      slug: "cron-guard",
    });

    const [msg] = await srv.db
      .insert(conversationMessages)
      .values({ tenant_id: srv.tenantId, conversation_id, role: "user", content: { text: "cron" } })
      .returning();

    const result = await forkConversation(
      {
        tenant_id: srv.tenantId,
        source_conversation_id: conversation_id,
        anchor_message_id: msg!.id,
        actor_id: null,
        actor_type: "system",
        request_source: "api",
      },
      srv.db,
    );
    expect(result).not.toBeNull();

    // Run the cleanup cron — files linked from both source + fork should NOT be reaped
    await runFilesCleanup(new Date(FROZEN_NOW), srv.db);

    // The file row must still be `ready` (not `deleted`)
    const [fileRow] = await srv.db
      .select({ status: files.status, deleted_at: files.deleted_at })
      .from(files)
      .where(eq(files.id, att.file_uuid));
    expect(fileRow).toBeDefined();
    expect(fileRow!.status).toBe("ready");
    expect(fileRow!.deleted_at).toBeNull();
  });
});
