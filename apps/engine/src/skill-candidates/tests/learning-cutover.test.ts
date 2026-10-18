import { afterAll, beforeAll, expect, test } from "bun:test";
import { collectSessionLearning } from "../../agent/sessions.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { cutOverLearningCandidates } from "../learning-cutover.ts";

const skip = process.env.REQUIRES_PG === "0";

interface SeedCandidate {
  id: string;
  pattern_kind: string;
  status: string;
  title: string;
  body: string;
  tags: string[];
  scope?: string;
  connector_id?: string | null;
  proposed_by_user_id?: string | null;
  examples?: Record<string, unknown>;
  evidence?: Array<{ type: string; summary: string; at: string }>;
}

let ctx: TestDb;

beforeAll(async () => {
  if (skip) return;
  ctx = await createTestDb("learning_cutover");
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
});

async function seedTenant(tenantId: string, slug: string): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO subkit.tenants (id, slug, display_name) VALUES ($1, $2, 'Learning cutover')`,
    [tenantId, slug],
  );
  await ctx.pool.query(
    `INSERT INTO subkit.catalog_categories (tenant_id, name) VALUES ($1, 'blog-de')`,
    [tenantId],
  );
}

async function seedCandidate(tenantId: string, c: SeedCandidate): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO subkit.skill_candidates
      (id, tenant_id, scope, connector_id, pattern_kind, title, body, examples, evidence, confidence,
       status, fingerprint, tags, proposed_by_user_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, '[]'::jsonb, 'high', $9, $10, $11, $12,
             '2026-09-01T10:00:00.000Z')`,
    [
      c.id,
      tenantId,
      c.scope ?? "global",
      c.connector_id ?? null,
      c.pattern_kind,
      c.title,
      c.body,
      JSON.stringify(c.examples ?? {}),
      c.status,
      `fp-${c.id}`,
      c.tags,
      c.proposed_by_user_id ?? null,
    ],
  );
  for (const evidence of c.evidence ?? []) {
    await ctx.pool.query(
      `INSERT INTO subkit.skill_candidate_evidence
        (skill_candidate_id, evidence_type, summary, captured_at)
       VALUES ($1, $2, $3, $4)`,
      [c.id, evidence.type, evidence.summary, evidence.at],
    );
  }
}

async function statuses(tenantId: string): Promise<Record<string, string>> {
  const rows = await ctx.pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM subkit.skill_candidates WHERE tenant_id = $1`,
    [tenantId],
  );
  return Object.fromEntries(rows.rows.map((row) => [row.id, row.status]));
}

test.skipIf(skip)(
  "open learnings become session intake items with their scope, tags and evidence",
  async () => {
    const nextId = createDeterministicUuidFactory(1_141);
    const tenantId = nextId();
    const userId = nextId();
    const connectorId = nextId();
    const hookLearning = nextId();
    const savedFact = nextId();
    const authoredSkill = nextId();
    const rejected = nextId();
    const detected = nextId();
    const existingClip = nextId();
    const matchesClip = nextId();
    await seedTenant(tenantId, "learning-cutover");
    await seedCandidate(tenantId, {
      id: hookLearning,
      pattern_kind: "session_learning",
      status: "proposed",
      title: "Halbgeviertstrich als Gedankenstrich",
      body: "Gedankenstriche sind Halbgeviertstriche.  ",
      tags: ["domain:blog-de"],
      examples: { pitfalls: ["Nie den Bindestrich."], best_practices: [], examples: [] },
      evidence: [
        {
          type: "agent_session",
          summary: "agent=claude-code session=sess-1 repo=example/blog domains=blog-de",
          at: "2026-09-01T10:00:00.000Z",
        },
      ],
    });
    await seedCandidate(tenantId, {
      id: savedFact,
      pattern_kind: "knowledge_learning",
      status: "proposed",
      title: "  halbgeviertstrich als   gedankenstrich",
      body: "Gilt für alle Artikel.",
      tags: ["domain:blog-de"],
      evidence: [
        {
          type: "agent_session",
          summary: "explicit save_learning (conversation=conv-1)",
          at: "2026-09-02T10:00:00.000Z",
        },
      ],
    });
    await seedCandidate(tenantId, {
      id: authoredSkill,
      pattern_kind: "session_learning",
      status: "proposed",
      title: "Paginate the orders endpoint",
      body: "Always follow the next cursor.",
      tags: [],
      scope: "connector",
      connector_id: connectorId,
      proposed_by_user_id: userId,
      examples: { best_practices: ["Cap pages at 50."] },
      evidence: [
        {
          type: "conversation",
          summary: "explicit create_skill (conversation=conv-2)",
          at: "2026-09-03T10:00:00.000Z",
        },
      ],
    });
    await ctx.pool.query(
      `INSERT INTO subkit.intake_items
        (id, tenant_id, category, client_request_id, creation_request_digest, original_snapshot,
         title, body, collected_by_type, collected_by_id, created_at)
       VALUES ($1, $2, 'blog-de', $3, 'clip-digest', $4::jsonb, 'Vorhandener Clip', 'Clip body',
               'user', $5, '2026-08-01T10:00:00.000Z')`,
      [
        existingClip,
        tenantId,
        nextId(),
        JSON.stringify({
          title: "Vorhandener Clip",
          source_url: "https://example.test/clip",
          captured_at: "2026-08-01T10:00:00.000Z",
          body: "Clip body",
          origin: "capture",
        }),
        userId,
      ],
    );
    await seedCandidate(tenantId, {
      id: matchesClip,
      pattern_kind: "session_learning",
      status: "proposed",
      title: "vorhandener  clip",
      body: "Same topic as the clip.",
      tags: ["domain:blog-de"],
    });
    await seedCandidate(tenantId, {
      id: rejected,
      pattern_kind: "session_learning",
      status: "rejected",
      title: "Rejected rule",
      body: "Was rejected.",
      tags: ["domain:blog-de"],
    });
    await seedCandidate(tenantId, {
      id: detected,
      pattern_kind: "success_pattern",
      status: "proposed",
      title: "Detected pattern",
      body: "Detected body.",
      tags: [],
    });

    expect(await cutOverLearningCandidates(ctx.db)).toEqual({ collected: 4, dropped: 0 });

    const collector = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM subkit.system_accounts WHERE tenant_id = $1 AND name = 'session-learnings'`,
      [tenantId],
    );
    const collectorId = collector.rows[0]?.id;
    expect(collectorId).toBeDefined();

    const items = await ctx.pool.query<{
      id: string;
      category: string;
      title: string;
      body: string;
      state: string;
      version: number;
      collected_by_type: string;
      collected_by_id: string;
      original_snapshot: Record<string, unknown>;
    }>(
      `SELECT id, category, title, body, state, version, collected_by_type, collected_by_id,
              original_snapshot
         FROM subkit.intake_items WHERE tenant_id = $1 ORDER BY title COLLATE "C"`,
      [tenantId],
    );
    expect(items.rows.map((row) => row.title)).toEqual([
      "Halbgeviertstrich als Gedankenstrich",
      "Paginate the orders endpoint",
      "Vorhandener Clip",
      "vorhandener  clip",
    ]);
    const [hookItem, connectorItem, clipItem, sessionTwin] = items.rows;
    expect(clipItem).toMatchObject({ id: existingClip, version: 1 });
    expect(sessionTwin).toMatchObject({
      category: "blog-de",
      original_snapshot: { origin: "session", session_id: `skill-candidate:${matchesClip}` },
    });
    expect(hookItem).toMatchObject({
      category: "blog-de",
      body: "Gedankenstriche sind Halbgeviertstriche.\n\nPitfalls:\n- Nie den Bindestrich.",
      state: "collected",
      version: 1,
      collected_by_type: "system_account",
      collected_by_id: collectorId,
      original_snapshot: {
        origin: "session",
        agent: "claude-code",
        session_id: "sess-1",
        repo: "example/blog",
        domains: ["blog-de"],
        learning_kind: "practice",
        scope: "global",
        tags: ["domain:blog-de"],
        captured_at: "2026-09-01T10:00:00.000Z",
      },
    });
    expect(connectorItem).toMatchObject({
      category: "inbox",
      body: "Always follow the next cursor.\n\nBest practices:\n- Cap pages at 50.",
      collected_by_type: "user",
      collected_by_id: userId,
      original_snapshot: {
        origin: "session",
        agent: "create_skill",
        session_id: "conv-2",
        repo: null,
        domains: [],
        scope: "connector",
        connector_id: connectorId,
      },
    });
    expect(connectorItem?.original_snapshot).not.toHaveProperty("tags");

    const evidence = await ctx.pool.query<{ item_id: string; agent: string; session_id: string }>(
      `SELECT item_id, agent, session_id FROM subkit.intake_item_evidence
        WHERE tenant_id = $1 ORDER BY captured_at, session_id COLLATE "C"`,
      [tenantId],
    );
    expect(evidence.rows).toEqual([
      { item_id: hookItem?.id ?? "", agent: "claude-code", session_id: "sess-1" },
      {
        item_id: sessionTwin?.id ?? "",
        agent: "session",
        session_id: `skill-candidate:${matchesClip}`,
      },
      { item_id: hookItem?.id ?? "", agent: "save_learning", session_id: "conv-1" },
      { item_id: connectorItem?.id ?? "", agent: "create_skill", session_id: "conv-2" },
    ]);

    expect(await statuses(tenantId)).toEqual({
      [hookLearning]: "superseded",
      [savedFact]: "superseded",
      [authoredSkill]: "superseded",
      [matchesClip]: "superseded",
      [rejected]: "rejected",
      [detected]: "proposed",
    });
    const audits = await ctx.pool.query<{ action: string; total: number }>(
      `SELECT action, count(*)::int AS total FROM subkit.audit_log
        WHERE tenant_id = $1 AND metadata ->> 'request_source' = 'migration'
        GROUP BY action ORDER BY action`,
      [tenantId],
    );
    expect(audits.rows).toEqual([
      { action: "intake_item.collected", total: 3 },
      { action: "intake_item.evidence_appended", total: 1 },
      { action: "skill_candidate.superseded", total: 4 },
    ]);

    expect(await cutOverLearningCandidates(ctx.db)).toEqual({ collected: 0, dropped: 0 });
    const again = await ctx.pool.query<{ items: number; evidence: number }>(
      `SELECT
         (SELECT count(*)::int FROM subkit.intake_items WHERE tenant_id = $1) AS items,
         (SELECT count(*)::int FROM subkit.intake_item_evidence WHERE tenant_id = $1) AS evidence`,
      [tenantId],
    );
    expect(again.rows[0]).toEqual({ items: 4, evidence: 4 });

    const retaught = await collectSessionLearning({
      tenant_id: tenantId,
      title: "Halbgeviertstrich als Gedankenstrich",
      body: "Gedankenstriche sind Halbgeviertstriche.",
      kind: "practice",
      actor: null,
      session: { agent: "codex", session_id: "sess-2", domains: ["blog-de"] },
      evidence_excerpt: "user: wie besprochen",
      db: ctx.db,
    });
    expect(retaught).toEqual({ outcome: "evidence_appended", intake_item_id: hookItem?.id ?? "" });
    expect((await statuses(tenantId))[hookLearning]).toBe("superseded");
  },
);

test.skipIf(skip)(
  "the cutover masks secrets and drops learnings that point at key material",
  async () => {
    const nextId = createDeterministicUuidFactory(1_142);
    const tenantId = nextId();
    const secretBearing = nextId();
    const keyPathBody = nextId();
    const keyPathEvidence = nextId();
    const token = `ghp_${"A1b2C3d4E5".repeat(4)}`;
    await seedTenant(tenantId, "learning-cutover-redaction");
    await seedCandidate(tenantId, {
      id: secretBearing,
      pattern_kind: "session_learning",
      status: "proposed",
      title: "Use the deploy token",
      body: `Authenticate with ${token} before pushing.`,
      tags: ["domain:blog-de"],
      examples: { pitfalls: [`Never echo ${token}.`] },
      evidence: [
        {
          type: "agent_session",
          summary: `agent=codex session=sess-9 repo=example/blog user: the token is ${token}`,
          at: "2026-09-04T10:00:00.000Z",
        },
      ],
    });
    await seedCandidate(tenantId, {
      id: keyPathBody,
      pattern_kind: "session_learning",
      status: "proposed",
      title: "Deploy key location",
      body: "The deploy key lives in ~/.ssh/id_ed25519.",
      tags: ["domain:blog-de"],
    });
    await seedCandidate(tenantId, {
      id: keyPathEvidence,
      pattern_kind: "knowledge_learning",
      status: "proposed",
      title: "Staging database name",
      body: "Staging uses the blog_staging database.",
      tags: ["domain:blog-de"],
      evidence: [
        {
          type: "agent_session",
          summary: "agent=codex session=sess-10 user: copied from /srv/app/.env.production",
          at: "2026-09-05T10:00:00.000Z",
        },
      ],
    });

    expect(await cutOverLearningCandidates(ctx.db)).toEqual({ collected: 1, dropped: 2 });

    const items = await ctx.pool.query<{
      id: string;
      title: string;
      body: string;
      original_snapshot: Record<string, unknown>;
    }>(`SELECT id, title, body, original_snapshot FROM subkit.intake_items WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(items.rows).toHaveLength(1);
    const [item] = items.rows;
    const stored = JSON.stringify(item);
    expect(stored).not.toContain(token);
    expect(item?.body).toContain("REDACTED");
    const evidence = await ctx.pool.query<{ excerpt: string }>(
      `SELECT excerpt FROM subkit.intake_item_evidence WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]?.excerpt).not.toContain(token);
    expect(JSON.stringify(items.rows)).not.toContain("id_ed25519");

    expect(await statuses(tenantId)).toEqual({
      [secretBearing]: "superseded",
      [keyPathBody]: "superseded",
      [keyPathEvidence]: "superseded",
    });
    const reasons = await ctx.pool.query<{ resource_id: string; reason: string }>(
      `SELECT resource_id, metadata ->> 'reason' AS reason FROM subkit.audit_log
        WHERE tenant_id = $1 AND action = 'skill_candidate.superseded' ORDER BY resource_id`,
      [tenantId],
    );
    expect(Object.fromEntries(reasons.rows.map((row) => [row.resource_id, row.reason]))).toEqual({
      [secretBearing]: "collected_in_intake",
      [keyPathBody]: "dropped_by_redaction",
      [keyPathEvidence]: "dropped_by_redaction",
    });
  },
);
