// attachments.ts — parser + resolver tests.
//
// Uses memory:// URIs + putMemoryAttachment so the tests don't need S3
// or a filesystem path. The DB is still real (testcontainer) because
// the resolver queries conversation_attachments by (conv_id, slug).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { conversationAttachments, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  clearMemoryAttachments,
  collectAttachmentSlugs,
  parseAttachmentRefs,
  putMemoryAttachment,
  resolveAttachments,
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

afterEach(() => {
  clearMemoryAttachments();
});

async function seedAttachment(opts: {
  slug: string;
  content: string;
  filename?: string;
  content_type?: string | null;
}): Promise<void> {
  const key = `${conversation_id}:${opts.slug}`;
  putMemoryAttachment(key, opts.content);
  await ctx.db
    .insert(conversationAttachments)
    .values({
      tenant_id,
      conversation_id,
      slug: opts.slug,
      original_filename: opts.filename ?? `${opts.slug}.txt`,
      content_type: opts.content_type ?? "text/plain",
      size_bytes: opts.content.length,
      storage_uri: `memory://${key}`,
      sha256: "fake",
      preview: opts.content.slice(0, 200),
    })
    .onConflictDoNothing();
}

describe("parseAttachmentRefs — happy-path shapes", () => {
  test("single ref, standalone", () => {
    const refs = parseAttachmentRefs("@attachment:stripe-spec");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.slug).toBe("stripe-spec");
    expect(refs[0]!.isStandalone).toBe(true);
  });

  test("single ref, embedded — isStandalone=false", () => {
    const refs = parseAttachmentRefs("use @attachment:spec now");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.slug).toBe("spec");
    expect(refs[0]!.isStandalone).toBe(false);
  });

  test("two refs in one string", () => {
    const refs = parseAttachmentRefs("@attachment:a and @attachment:b");
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.slug)).toEqual(["a", "b"]);
  });

  test("invalid slug (uppercase) is not matched", () => {
    const refs = parseAttachmentRefs("@attachment:BadSlug");
    expect(refs).toEqual([]);
  });
});

describe("collectAttachmentSlugs — deep walk", () => {
  test("finds slugs in nested object/array structures", () => {
    const slugs = collectAttachmentSlugs({
      headers: { authorization: "Bearer X" },
      body: {
        file: "@attachment:spec",
        refs: [{ slug: "@attachment:notes" }, "@attachment:extra"],
      },
    });
    expect(slugs.sort()).toEqual(["extra", "notes", "spec"]);
  });

  test("returns [] for payloads without refs", () => {
    expect(collectAttachmentSlugs({ a: 1, b: [1, 2] })).toEqual([]);
  });
});

describe("resolveAttachments — standalone vs embedded", () => {
  test("standalone JSON attachment → parsed object replaces the string", async () => {
    await seedAttachment({
      slug: "users-json",
      filename: "users.json",
      content_type: "application/json",
      content: JSON.stringify([{ id: 1, email: "ada@example.test" }]),
    });
    const r = await resolveAttachments(
      { body: "@attachment:users-json" },
      { tenant_id, conversation_id, db: ctx.db },
    );
    expect(r.unresolved).toEqual([]);
    const body = (r.value as { body: unknown }).body;
    expect(Array.isArray(body)).toBe(true);
    expect((body as Array<{ id: number }>)[0]!.id).toBe(1);
  });

  test("standalone text attachment → raw string replaces the string", async () => {
    await seedAttachment({
      slug: "note",
      content: "Use only v3 endpoints.",
      content_type: "text/plain",
    });
    const r = await resolveAttachments(
      { instructions: "@attachment:note" },
      { tenant_id, conversation_id, db: ctx.db },
    );
    expect((r.value as { instructions: string }).instructions).toBe("Use only v3 endpoints.");
  });

  test("embedded ref → inline raw text substitution", async () => {
    await seedAttachment({ slug: "x", content: "ALPHA" });
    const r = await resolveAttachments(
      { line: "prefix @attachment:x suffix" },
      { tenant_id, conversation_id, db: ctx.db },
    );
    expect((r.value as { line: string }).line).toBe("prefix ALPHA suffix");
  });

  test("multiple refs in one string all substitute", async () => {
    await seedAttachment({ slug: "a", content: "A1" });
    await seedAttachment({ slug: "b", content: "B2" });
    const r = await resolveAttachments(
      { line: "@attachment:a / @attachment:b" },
      { tenant_id, conversation_id, db: ctx.db },
    );
    expect((r.value as { line: string }).line).toBe("A1 / B2");
  });

  test("unresolved slug → entry in unresolved + literal kept in string", async () => {
    const r = await resolveAttachments(
      { body: "@attachment:nope" },
      { tenant_id, conversation_id, db: ctx.db },
    );
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0]!.slug).toBe("nope");
    expect(r.unresolved[0]!.reason).toBe("not_found");
    // Body stays as the literal marker
    expect((r.value as { body: string }).body).toBe("@attachment:nope");
  });

  test("slugs_used is deduplicated across the whole walk", async () => {
    await seedAttachment({ slug: "shared", content: "S" });
    const r = await resolveAttachments(
      {
        headers: { a: "@attachment:shared" },
        body: { nested: "@attachment:shared here" },
      },
      { tenant_id, conversation_id, db: ctx.db },
    );
    expect(r.slugs_used).toEqual(["shared"]);
  });
});

describe("resolveAttachments — non-string values pass through", () => {
  test("numbers, booleans, nulls unchanged", async () => {
    const input = { n: 42, b: true, z: null };
    const r = await resolveAttachments(input, {
      tenant_id,
      conversation_id,
      db: ctx.db,
    });
    expect(r.value).toEqual(input);
    expect(r.slugs_used).toEqual([]);
  });
});

describe("resolveAttachments — cross-conversation isolation", () => {
  test("attachment from another conversation does not resolve", async () => {
    // Seed an attachment on a DIFFERENT conversation.
    const [otherConv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active" })
      .returning();
    const key = `${otherConv!.id}:isolated`;
    putMemoryAttachment(key, "cross-leak");
    await ctx.db.insert(conversationAttachments).values({
      tenant_id,
      conversation_id: otherConv!.id,
      slug: "isolated",
      original_filename: "iso.txt",
      content_type: "text/plain",
      size_bytes: 11,
      storage_uri: `memory://${key}`,
      sha256: "x",
    });
    // Attempt to resolve from OUR conversation.
    const r = await resolveAttachments(
      { body: "@attachment:isolated" },
      { tenant_id, conversation_id, db: ctx.db },
    );
    expect(r.unresolved[0]!.reason).toBe("not_found");
    expect(JSON.stringify(r.value).includes("cross-leak")).toBe(false);
  });
});
