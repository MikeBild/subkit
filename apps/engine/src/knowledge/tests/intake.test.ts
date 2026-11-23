import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { renameCategory } from "../../workflows/catalog-view.ts";
import {
  createIntakeProposal,
  createSessionIntakeItem,
  getIntakeItem,
  getIntakeProposal,
  listIntakeCategories,
  listIntakeItems,
  patchIntakeItem,
  reviseIntakeProposal,
} from "../index.ts";
import { IntakeConflictError, IntakeProposalConflictError } from "../intake-errors.ts";
import { searchKnowledge } from "../service.ts";
import {
  actor,
  confirmIntakeProposal,
  createClip,
  ctx,
  nextUuid,
  skip,
  useKnowledgeIntakeDb,
  withoutSimilarity,
} from "./intake-fixtures.ts";

useKnowledgeIntakeDb();

describe.skipIf(skip)("knowledge intake", () => {
  test("collects an immutable source snapshot into a per-principal default", async () => {
    const requestId = nextUuid();
    const first = await createClip({ client_request_id: requestId });
    const repeated = await createClip({ client_request_id: requestId });
    expect(repeated.id).toBe(first.id);
    expect(first.original_snapshot).toMatchObject({
      title: "Tape recording idea",
      source_url: expect.stringMatching(/^https:\/\/example\.test\/tape\//),
      published_at: "Spring issue",
      origin: "capture",
    });
    const categories = await listIntakeCategories(
      { tenant_id: ctx.tenantId, actor },
      ctx.testDb.db,
    );
    expect(categories.default_category).toBe("inbox");
    expect(categories.items).toContainEqual(
      expect.objectContaining({ category: "inbox", is_default: true }),
    );

    const edited = await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: first.id,
        expected_version: first.version,
        body: "Edited working copy",
        note: "Edited note",
      },
      ctx.testDb.db,
    );
    expect(edited?.body).toBe("Edited working copy");
    expect(edited?.original_snapshot.body).toBe("The original clip says useful things.");
    await expect(
      patchIntakeItem(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: first.id,
          expected_version: first.version,
          title: "A stale edit must fail",
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeConflictError);
    const afterEditRetry = await createClip({ client_request_id: requestId });
    expect(afterEditRetry.id).toBe(first.id);
  });

  test("collects a note without a source address as a redacted, audited intake entry", async () => {
    const pat = `ghp_${"c3D4".repeat(9)}`;
    const requestId = nextUuid();
    const params = {
      client_request_id: requestId,
      source_url: undefined,
      source_author: undefined,
      published_at: undefined,
      note: undefined,
      title: "Idea for the onboarding",
      body: `Ask about the team size first. token ${pat}`,
    };
    const note = await createClip(params);
    expect(note.state).toBe("collected");
    expect(note.admitted_target_id).toBeNull();
    expect(note.original_snapshot).toEqual({
      title: "Idea for the onboarding",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "Ask about the team size first. token ***REDACTED:pat***",
      origin: "note",
      redactions: 1,
    });
    expect(JSON.stringify(note)).not.toContain(pat);
    expect((await createClip(params)).id).toBe(note.id);
    await expect(
      createClip({ ...params, source_url: "https://example.test/now-with-address" }),
    ).rejects.toBeInstanceOf(IntakeConflictError);
    const [audit] = await ctx.testDb.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "intake_item.collected"),
          eq(auditLog.resource_id, note.id),
        ),
      );
    expect(audit?.metadata).toMatchObject({ origin: "note", source_url: null, redactions: 1 });
  });

  test("filters listed entries by origin within the tenant", async () => {
    const clip = await createClip({ title: "Origin filter clip" });
    const note = await createClip({ title: "Origin filter note", source_url: undefined });
    const session = (
      await createSessionIntakeItem(
        {
          tenant_id: ctx.tenantId,
          actor,
          title: "Origin filter session learning",
          body: "Prepared by an agent from a work session.",
          captured_at: "2026-10-10T07:00:00.000Z",
          session: {
            agent: "claude-code",
            session_id: `session-${nextUuid()}`,
            repo: null,
            domains: [],
            evidence_excerpt: "The agent noticed this during the session.",
          },
        },
        ctx.testDb.db,
        withoutSimilarity,
      )
    ).item;
    const ids = async (origin: "capture" | "note" | "session") => {
      const items = await listIntakeItems({ tenant_id: ctx.tenantId, origin }, ctx.testDb.db);
      expect(items.every((item) => item.tenant_id === ctx.tenantId)).toBe(true);
      return items.map((item) => item.id);
    };
    const fromAgents = await ids("session");
    expect(fromAgents).toContain(session.id);
    expect(fromAgents).not.toContain(clip.id);
    expect(fromAgents).not.toContain(note.id);
    const notes = await ids("note");
    expect(notes).toContain(note.id);
    expect(notes).not.toContain(clip.id);
    const captures = await ids("capture");
    expect(captures).toContain(clip.id);
    expect(captures).not.toContain(note.id);
    expect(captures).not.toContain(session.id);
    expect(
      await listIntakeItems({ tenant_id: nextUuid(), origin: "session" }, ctx.testDb.db),
    ).toEqual([]);
  });

  test("redacts secrets from a collected clip and keeps prose, code and URLs intact", async () => {
    const pat = `ghp_${"a1B2".repeat(9)}`;
    const bearer = "Bearer fixture.token_value-123456";
    const privateKey =
      "-----BEGIN PRIVATE KEY-----\nZml4dHVyZS1rZXktbWF0ZXJpYWw=\n-----END PRIVATE KEY-----";
    const prose =
      "Bearer authentication is described at https://example.test/Understanding-OAuth2-And-OpenID-Connect-In-2024-Guide?page=2. const total = items.reduce((a, b) => a + b, 0);";
    const requestId = nextUuid();
    const params = {
      client_request_id: requestId,
      title: `Deploy notes ${pat}`,
      body: `${prose}\nAuthorization: ${bearer}\n${privateKey}`,
      note: `token ${pat}`,
    };
    const item = await createClip(params);
    const stored = JSON.stringify(item);
    expect(stored).not.toContain(pat);
    expect(stored).not.toContain("fixture.token_value-123456");
    expect(stored).not.toContain("Zml4dHVyZS1rZXktbWF0ZXJpYWw=");
    expect(item.title).toBe("Deploy notes ***REDACTED:pat***");
    expect(item.note).toBe("token ***REDACTED:pat***");
    expect(item.body).toContain(prose);
    expect(item.original_snapshot.body).toBe(item.body);
    expect(item.original_snapshot).toMatchObject({
      title: item.title,
      source_url: expect.stringMatching(/^https:\/\/example\.test\/tape\//),
      source_author: "Author",
      captured_at: "2026-10-10T07:00:00.000Z",
      redactions: 4,
    });
    expect(item.collected_by).toEqual(actor);

    const repeated = await createClip(params);
    expect(repeated.id).toBe(item.id);
    await expect(createClip({ ...params, body: "Different" })).rejects.toBeInstanceOf(
      IntakeConflictError,
    );

    const [audit] = await ctx.testDb.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "intake_item.collected"),
          eq(auditLog.resource_id, item.id),
        ),
      );
    expect(audit?.metadata).toMatchObject({ redactions: 4 });
    expect(JSON.stringify(audit?.metadata)).not.toContain(pat);

    const clean = await createClip();
    expect(clean.original_snapshot).not.toHaveProperty("redactions");

    const edited = await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: clean.id,
        expected_version: clean.version,
        body: `pasted again ${pat}`,
      },
      ctx.testDb.db,
    );
    expect(edited?.body).toBe("pasted again ***REDACTED:pat***");
  });

  test("renaming or moving an intake item never makes it searchable knowledge", async () => {
    const item = await createClip();
    const moved = await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: item.id,
        expected_version: item.version,
        category: "research",
      },
      ctx.testDb.db,
    );
    expect(moved?.category).toBe("research");
    expect(
      (await searchKnowledge({ tenant_id: ctx.tenantId, query: "original clip" }, ctx.testDb.db))
        .length,
    ).toBe(0);
  });

  test("category changes stale a reviewed proposal without changing the original source", async () => {
    const item = await createClip();
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Recording workflow",
        body: "Review the source before publishing.",
        target: { name: "Recording workflow" },
      },
      ctx.testDb.db,
    );
    const moved = await patchIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: item.id,
        expected_version: item.version,
        category: "research",
      },
      ctx.testDb.db,
    );
    expect(moved).toMatchObject({ category: "research", version: item.version + 1 });
    expect(moved?.original_snapshot).toEqual(item.original_snapshot);
    await expect(
      confirmIntakeProposal(
        {
          tenant_id: ctx.tenantId,
          actor,
          id: proposal.id,
          expected_revision: proposal.current_revision,
          digest: proposal.revision.digest,
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(IntakeProposalConflictError);
    const revised = await reviseIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        id: proposal.id,
        expected_revision: proposal.current_revision,
        item_ids: [item.id],
        title: "Recording workflow",
        body: "Review the source before publishing.",
        target: { name: "Recording workflow" },
      },
      ctx.testDb.db,
    );
    expect(revised?.status).toBe("draft");
  });

  test("working-copy changes stale a reviewed proposal without changing the source snapshot", async () => {
    for (const change of [
      { title: "Edited title" },
      { body: "Edited working copy" },
      { note: "Edited note" },
      { state: "collected" as const },
    ]) {
      const item = await createClip();
      const proposal = await createIntakeProposal(
        {
          tenant_id: ctx.tenantId,
          actor,
          item_ids: [item.id],
          title: "Recording workflow",
          body: "Review the source before publishing.",
          target: { name: "Recording workflow" },
        },
        ctx.testDb.db,
      );
      const edited = await patchIntakeItem(
        { tenant_id: ctx.tenantId, actor, id: item.id, expected_version: item.version, ...change },
        ctx.testDb.db,
      );
      expect(edited?.original_snapshot).toEqual(item.original_snapshot);
      expect((await getIntakeProposal(ctx.tenantId, proposal.id, ctx.testDb.db))?.status).toBe(
        "stale",
      );
      await expect(
        confirmIntakeProposal(
          {
            tenant_id: ctx.tenantId,
            actor,
            id: proposal.id,
            expected_revision: proposal.current_revision,
            digest: proposal.revision.digest,
          },
          ctx.testDb.db,
        ),
      ).rejects.toBeInstanceOf(IntakeProposalConflictError);
    }
  });

  test("renaming a shared intake category versions clips and stales affected targets", async () => {
    const item = await createClip({ category: "recording" });
    const proposal = await createIntakeProposal(
      {
        tenant_id: ctx.tenantId,
        actor,
        item_ids: [item.id],
        title: "Recording guidance",
        body: "Keep source context.",
        target: { name: "Recording guidance", category: "recording" },
      },
      ctx.testDb.db,
    );
    const moved = await renameCategory(
      {
        tenant_id: ctx.tenantId,
        from: "recording",
        to: "audio",
        actor_type: "system",
        purpose: null,
        aliases: [],
        expected_source_revision: 1,
        expected_target_revision: null,
      },
      ctx.testDb.db,
    );
    expect(moved.moved.intake).toBe(1);
    expect(await getIntakeItem(ctx.tenantId, item.id, ctx.testDb.db)).toMatchObject({
      category: "audio",
      version: item.version + 1,
      original_snapshot: item.original_snapshot,
    });
    expect((await getIntakeProposal(ctx.tenantId, proposal.id, ctx.testDb.db))?.status).toBe(
      "stale",
    );
  });

  test("does not expose a clip across tenants", async () => {
    const item = await createClip();
    const otherTenant = await seedTenant(ctx.testDb.db, {
      slug: "t-intake-other",
      display_name: "Other intake tenant",
    });
    expect(await getIntakeItem(otherTenant.id, item.id, ctx.testDb.db)).toBeNull();
  });

  test("serializes concurrent defaults and idempotent requests", async () => {
    const requestId = nextUuid();
    const [first, second] = await Promise.all([
      createClip({ client_request_id: requestId }),
      createClip({ client_request_id: requestId }),
    ]);
    expect(first.id).toBe(second.id);
    const defaults = await listIntakeCategories({ tenant_id: ctx.tenantId, actor }, ctx.testDb.db);
    expect(defaults.default_category).toBe("inbox");
    await expect(
      createClip({ client_request_id: requestId, body: "Different" }),
    ).rejects.toBeInstanceOf(IntakeConflictError);
  });
});
