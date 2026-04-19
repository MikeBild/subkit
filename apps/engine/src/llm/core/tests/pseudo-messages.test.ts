// Pseudo-messages tests — each builder against realistic seed data.
//
// We exercise the DB-backed builders in a testcontainer and the pure
// RBAC builder directly. Shape-level assertions only: the prompt is
// surface material, and brittle regex matching would chain the test to
// every copy edit. The tests that matter:
//
//   - Empty tenant → every DB builder returns null (tenant onboarding
//     flow uses that signal to switch messages).
//   - With seeded data, the block contains the exact counts and named
//     identifiers the operator would see in the UI.
//   - Top-level `buildAllPseudoMessages` concatenates in a stable order
//     and returns null only when every builder returned null.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  connectors,
  conversationAttachments,
  conversations,
  discoveryArtifacts,
  discoveryRuns,
  skills,
  tenants,
  workflows,
  workflowVersions,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import {
  buildAllPseudoMessages,
  buildAttachmentsMessage,
  buildDiscoveryMessage,
  buildLoadedSkillsMessage,
  buildRbacSnapshotMessage,
  buildTenantStateMessage,
} from "../pseudo-messages.ts";

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createTestDb("pseudo_messages");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-pm", display_name: "Pseudo" })
    .returning();
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

describe("buildTenantStateMessage", () => {
  test("empty tenant → null", async () => {
    const [freshT] = await ctx.db
      .insert(tenants)
      .values({ slug: "empty-pm", display_name: "empty" })
      .returning();
    const msg = await buildTenantStateMessage({
      tenant_id: freshT!.id,
      db: ctx.db,
    });
    expect(msg).toBeNull();
  });

  test("tenant with 2 workflows + 1 connector → block includes counts", async () => {
    // seed two workflows (w/ versions) + one connector for our tenant
    for (const s of ["wf-a", "wf-b"]) {
      const [w] = await ctx.db
        .insert(workflows)
        .values({
          tenant_id,
          slug: s,
          name: s,
          lifecycle: "active",
        })
        .returning();
      await ctx.db.insert(workflowVersions).values({
        tenant_id,
        workflow_id: w!.id,
        version: 1,
        dag: { name: s, steps: [] },
      });
    }
    await ctx.db.insert(connectors).values({
      tenant_id,
      slug: "conn1",
      display_name: "conn1",
      driver: "http",
      environment: "dev",
      auth_type: "none",
    });
    const msg = await buildTenantStateMessage({ tenant_id, db: ctx.db });
    expect(msg).not.toBeNull();
    expect(msg).toContain("[TENANT STATE]");
    expect(msg).toContain("workflows: 2");
    expect(msg).toContain("connectors: 1");
  });
});

describe("buildRbacSnapshotMessage", () => {
  test("no principal → null", () => {
    expect(buildRbacSnapshotMessage({})).toBeNull();
    expect(buildRbacSnapshotMessage({ principal: null })).toBeNull();
  });

  test("empty roles + empty scopes → null", () => {
    expect(buildRbacSnapshotMessage({ principal: { roles: [], scopes: [] } })).toBeNull();
  });

  test("principal with roles renders role line", () => {
    const msg = buildRbacSnapshotMessage({
      principal: { roles: ["admin", "developer"], scopes: [] },
    });
    expect(msg).toContain("[RBAC SNAPSHOT]");
    expect(msg).toContain("roles: admin, developer");
  });

  test("scope list >10 gets a (+N more) suffix", () => {
    const scopes = Array.from({ length: 15 }, (_, i) => `scope:${i}`);
    const msg = buildRbacSnapshotMessage({
      principal: { roles: ["r"], scopes },
    });
    expect(msg).toContain("(+5 more)");
  });
});

describe("buildAttachmentsMessage", () => {
  test("no attachments → null", async () => {
    const msg = await buildAttachmentsMessage({
      tenant_id,
      conversation_id,
      db: ctx.db,
    });
    expect(msg).toBeNull();
  });

  test("with seeded attachments → block shows slug + filename + size", async () => {
    await ctx.db.insert(conversationAttachments).values({
      tenant_id,
      conversation_id,
      slug: "stripe-spec",
      original_filename: "stripe-openapi.yaml",
      content_type: "application/yaml",
      size_bytes: 84200,
      storage_uri: "s3://test/stripe-openapi.yaml",
      sha256: "abc",
      preview: "openapi: 3.0.3\ninfo:\n  title: Stripe",
    });
    const msg = await buildAttachmentsMessage({
      tenant_id,
      conversation_id,
      db: ctx.db,
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain("[ATTACHMENTS] (n=1)");
    expect(msg).toContain("stripe-spec");
    expect(msg).toContain("stripe-openapi.yaml");
    expect(msg).toContain("82.2 KB");
    expect(msg).toContain("preview: openapi: 3.0.3");
    expect(msg).toContain("@attachment:<slug>");
  });
});

describe("buildDiscoveryMessage", () => {
  test("no runs → null", async () => {
    const [freshT] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-disc-empty", display_name: "d" })
      .returning();
    const msg = await buildDiscoveryMessage({
      tenant_id: freshT!.id,
      db: ctx.db,
    });
    expect(msg).toBeNull();
  });

  test("with seeded run + artifacts → block shows run + artifact count", async () => {
    const [run] = await ctx.db
      .insert(discoveryRuns)
      .values({
        tenant_id,
        status: "completed",
        started_at: new Date(),
        completed_at: new Date(),
      })
      .returning();
    await ctx.db.insert(discoveryArtifacts).values({
      tenant_id,
      run_id: run!.id,
      kind: "connector",
      confidence: 90,
      title: "Stripe API",
      draft: { slug: "stripe-detected" },
      evidence: { file_ids: [], excerpts: [] },
    });
    const msg = await buildDiscoveryMessage({ tenant_id, db: ctx.db });
    expect(msg).not.toBeNull();
    expect(msg).toContain("[DISCOVERY]");
    expect(msg).toContain("1 artifact");
    expect(msg).toContain("approve_discovery_artifact");
  });
});

describe("buildLoadedSkillsMessage", () => {
  test("empty loaded_skills → null", async () => {
    const [freshConv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active" })
      .returning();
    const msg = await buildLoadedSkillsMessage({
      tenant_id,
      conversation_id: freshConv!.id,
      db: ctx.db,
    });
    expect(msg).toBeNull();
  });

  test("with loaded skills → block lists slug + title", async () => {
    // seed a global skill for the tenant
    await ctx.db.insert(skills).values({
      tenant_id,
      slug: "http-connectors",
      title: "HTTP Connectors",
      body: "body",
      scope: "global",
      lifecycle: "active",
      source: "template",
    });
    // mark the skill as loaded on the conversation row
    const { eq } = await import("drizzle-orm");
    await ctx.db
      .update(conversations)
      .set({ loaded_skills: ["http-connectors"] })
      .where(eq(conversations.id, conversation_id));

    const msg = await buildLoadedSkillsMessage({
      tenant_id,
      conversation_id,
      db: ctx.db,
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain("[LOADED SKILLS] (n=1)");
    expect(msg).toContain("http-connectors");
    expect(msg).toContain("HTTP Connectors");
  });
});

describe("buildAllPseudoMessages", () => {
  test("returns concatenated text with every non-null block", async () => {
    const msg = await buildAllPseudoMessages({
      tenant_id,
      conversation_id,
      db: ctx.db,
      principal: { roles: ["admin"], scopes: [] },
    });
    expect(msg).not.toBeNull();
    // At this point we have workflows + attachments + discovery +
    // loaded skills seeded on the shared tenant/conversation, so every
    // block should appear.
    const s = msg ?? "";
    expect(s).toContain("[TENANT STATE]");
    expect(s).toContain("[RBAC SNAPSHOT]");
    expect(s).toContain("[ATTACHMENTS]");
    expect(s).toContain("[DISCOVERY]");
    expect(s).toContain("[LOADED SKILLS]");
  });

  test("empty tenant falls back to onboarding hint (not null)", async () => {
    const [freshT] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-pm-null", display_name: "null" })
      .returning();
    const [freshConv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id: freshT!.id, status: "active" })
      .returning();
    const msg = await buildAllPseudoMessages({
      tenant_id: freshT!.id,
      conversation_id: freshConv!.id,
      db: ctx.db,
    });
    // Onboarding hint ALWAYS fills in when the tenant has no connectors
    // — a truly silent prompt would leave a new operator with no hook.
    expect(msg).not.toBeNull();
    expect(msg).toContain("[ONBOARDING]");
  });
});
