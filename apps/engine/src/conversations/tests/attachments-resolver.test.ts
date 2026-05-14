// attachments.ts — parser + resolver tests against the unified
// `files` + `file_links` resource.
//
// Wave-C Step 6 collapsed the legacy `conversation_attachments` table
// + in-process MEMORY_STORE into the canonical files resource. The
// tests below exercise the new surface:
//   - `parseAttachmentSlugs` (chat-text token scan, pure)
//   - `resolveAttachmentSlugsInText` (slug → `[file:fid_...]` rewriter
//     scoped to `file_links WHERE resource_type='conversation'`)
//   - `walkAndResolve` (JSON `$file` ref → ResolvedFile, the canonical
//     tenant-isolation chokepoint).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseFileId } from "../../api/files-schemas.ts";
import { conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import {
  FileNotFoundError,
  parseAttachmentSlugs,
  type ResolvedFile,
  resolveAttachmentSlugsInText,
  walkAndResolve,
} from "../attachments.ts";

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createTestDb("attachments_resolver");
  const [t] = await ctx.db.insert(tenants).values({ slug: "t-att", display_name: "T" }).returning();
  tenant_id = t!.id;
  const [c] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  conversation_id = c!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("parseAttachmentSlugs — chat-text scan", () => {
  test("single ref", () => {
    const refs = parseAttachmentSlugs("@attachment:stripe-spec");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.slug).toBe("stripe-spec");
  });

  test("single embedded ref", () => {
    const refs = parseAttachmentSlugs("use @attachment:spec now");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.slug).toBe("spec");
  });

  test("two refs in one string", () => {
    const refs = parseAttachmentSlugs("@attachment:a and @attachment:b");
    expect(refs.map((r) => r.slug)).toEqual(["a", "b"]);
  });

  test("invalid slug (uppercase) is not matched", () => {
    expect(parseAttachmentSlugs("@attachment:BadSlug")).toEqual([]);
  });
});

describe("resolveAttachmentSlugsInText — chat-text rewriter", () => {
  test("known slug → [file:fid_...] sentinel", async () => {
    const att = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "users.json",
      content_type: "application/json",
      content: JSON.stringify([{ id: 1 }]),
      slug: "users-json",
    });
    const r = await resolveAttachmentSlugsInText("use @attachment:users-json now", {
      db: ctx.db,
      tenant_id,
      conversation_id,
    });
    expect(r.unresolved).toEqual([]);
    expect(r.resolved).toEqual([{ slug: "users-json", file_id: att.file_id }]);
    expect(r.text).toBe(`use [file:${att.file_id}] now`);
  });

  test("unknown slug → literal kept, surfaced in unresolved", async () => {
    const r = await resolveAttachmentSlugsInText("@attachment:nope", {
      db: ctx.db,
      tenant_id,
      conversation_id,
    });
    expect(r.unresolved).toEqual(["nope"]);
    expect(r.text).toBe("@attachment:nope");
  });

  test("multiple refs all rewritten in one pass", async () => {
    const a = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "a.txt",
      content: "A1",
      slug: "a",
    });
    const b = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "b.txt",
      content: "B2",
      slug: "b",
    });
    const r = await resolveAttachmentSlugsInText("@attachment:a / @attachment:b", {
      db: ctx.db,
      tenant_id,
      conversation_id,
    });
    expect(r.text).toBe(`[file:${a.file_id}] / [file:${b.file_id}]`);
  });
});

describe("walkAndResolve — JSON `$file` resolver", () => {
  test("standalone ref → ResolvedFile leaf", async () => {
    const att = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "spec.json",
      content_type: "application/json",
      content: JSON.stringify({ ok: true }),
      slug: "spec",
    });
    const cache = new Map<string, ResolvedFile>();
    const out = await walkAndResolve<unknown>(
      { body: { $file: att.file_id } },
      { db: ctx.db, tenant_id },
      cache,
    );
    const body = (out as { body: ResolvedFile }).body;
    expect(body.filename).toBe("spec.json");
    expect(body.content_type).toBe("application/json");
    expect(body.size_bytes).toBeGreaterThan(0);
  });

  test("nested ref deep in object", async () => {
    const att = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "nested.txt",
      content: "ALPHA",
      slug: "alpha",
    });
    const cache = new Map<string, ResolvedFile>();
    const out = await walkAndResolve<unknown>(
      { a: { b: [{ $file: att.file_id }] } },
      { db: ctx.db, tenant_id },
      cache,
    );
    const leaf = (out as { a: { b: ResolvedFile[] } }).a.b[0]!;
    expect(leaf.filename).toBe("nested.txt");
  });

  test("unknown fid → FileNotFoundError", async () => {
    const cache = new Map<string, ResolvedFile>();
    await expect(
      walkAndResolve(
        { body: { $file: "fid_00000000-0000-0000-0000-000000000000" } },
        { db: ctx.db, tenant_id },
        cache,
      ),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });

  test("cross-tenant fid → FileNotFoundError (chokepoint)", async () => {
    // Create another tenant + conversation; attach a file there.
    const [otherT] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-att-2", display_name: "T2" })
      .returning();
    const [otherConv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id: otherT!.id, status: "active" })
      .returning();
    const att = await attachInlineForTest({
      db: ctx.db,
      tenant_id: otherT!.id,
      conversation_id: otherConv!.id,
      filename: "isolated.txt",
      content: "cross-leak",
      slug: "isolated",
    });
    // Resolve from OUR tenant — must throw.
    const cache = new Map<string, ResolvedFile>();
    await expect(
      walkAndResolve<unknown>({ $file: att.file_id }, { db: ctx.db, tenant_id }, cache),
    ).rejects.toBeInstanceOf(FileNotFoundError);
    // Sanity — the file does exist under its real tenant.
    const okCache = new Map<string, ResolvedFile>();
    const out = await walkAndResolve<unknown>(
      { $file: att.file_id },
      { db: ctx.db, tenant_id: otherT!.id },
      okCache,
    );
    expect((out as ResolvedFile).filename).toBe("isolated.txt");
    // Ensure the wire id parses back to the underlying uuid.
    expect(parseFileId(att.file_id)).toBe(att.file_uuid);
  });

  test("per-call cache prevents double-read", async () => {
    const att = await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "cache.txt",
      content: "X",
      slug: "cache-test",
    });
    const cache = new Map<string, ResolvedFile>();
    const out = await walkAndResolve<unknown>(
      [{ $file: att.file_id }, { $file: att.file_id }],
      { db: ctx.db, tenant_id },
      cache,
    );
    const a = (out as ResolvedFile[])[0]!;
    const b = (out as ResolvedFile[])[1]!;
    expect(a).toBe(b); // identity-equal — cache populated on the first walk
    expect(cache.size).toBe(1);
  });
});
