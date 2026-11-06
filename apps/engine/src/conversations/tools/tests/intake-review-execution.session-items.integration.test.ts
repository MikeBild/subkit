import { describe, expect, test } from "bun:test";
import { createIntakeItem, patchIntakeItem } from "../../../knowledge/index.ts";
import { createSkill } from "../../../skills/service.ts";
import { createEmptyDraftDocument } from "../../authoring-state/index.ts";
import { getTool } from "../index.ts";
import { wrapOne } from "../sdk-wrap/invoke.ts";
import {
  createItem,
  createSessionItem,
  db,
  executeWrapped,
  newConversation,
  nextUuid,
  signals,
  tdb,
  tenantId,
  toolContext,
  useIntakeReviewExecutionSetup,
  userId,
  writeTool,
} from "./intake-review-execution-fixtures.ts";

useIntakeReviewExecutionSetup();

describe("intake review execution boundary", () => {
  test("a wrapped session item read blocks skill mutations later in the same tool chain", async () => {
    const item = await createSessionItem("Wrapped session learning");
    const { ctx } = toolContext(await newConversation());
    const chain = signals();
    const read = getTool("get_intake_item");
    if (!read) throw new Error("intake item tool is not registered");
    expect(
      (await executeWrapped(wrapOne(read, ctx, chain, [], db, {}, null), { id: item.id })).ok,
    ).toBe(true);
    for (const name of ["update_skill", "delete_skill"] as const) {
      let calls = 0;
      const result = await executeWrapped(
        wrapOne(
          writeTool(name, () => calls++),
          ctx,
          chain,
          [],
          db,
          {},
          null,
        ),
        {},
      );
      expect(result).toMatchObject({
        ok: false,
        data: { error: "intake_review_requires_human_confirmation" },
      });
      expect(calls).toBe(0);
    }
  });

  test("a session item proposes a skill target only at the version that was read", async () => {
    const item = await createSessionItem("Session skill learning");
    const { ctx } = toolContext(await newConversation());
    const read = getTool("get_intake_item");
    const propose = getTool("create_intake_proposal");
    if (!read || !propose) throw new Error("intake tools are not registered");
    const target = {
      skill: {
        new: { title: "Session skill", scope: "global", tags: [], category: "jira" },
        supersedes: [],
      },
    };
    expect(propose.inputSchema.safeParse({ title: "t", body: "b", target }).success).toBe(true);
    expect(
      propose.inputSchema.safeParse({
        title: "t",
        body: "b",
        target: { skill: { supersedes: [] } },
      }).success,
    ).toBe(false);
    expect(await read.execute(ctx, { id: item.id })).toMatchObject({ ok: true });
    await patchIntakeItem(
      {
        tenant_id: tenantId,
        actor: { kind: "user", id: userId },
        id: item.id,
        expected_version: item.version,
        body: "Edited after the chat read it.",
      },
      tdb.db,
    );
    expect(
      await propose.execute(ctx, { title: "Session skill", body: "Use it.", target }),
    ).toMatchObject({ ok: false, data: { error: "intake_items_must_be_read" } });
    expect(await read.execute(ctx, { id: item.id })).toMatchObject({ ok: true });
    const proposal = await propose.execute(ctx, {
      title: "Session skill",
      body: "Use it.",
      target,
    });
    expect(proposal).toMatchObject({
      ok: true,
      data: {
        proposal: {
          status: "draft",
          revision: { items: [{ id: item.id, source_url: null }], target },
        },
      },
    });
  });

  test("an item read returns bounded session evidence and its domain knowledge target", async () => {
    const item = await createSessionItem("Domain target learning");
    await createSkill(
      {
        tenant_id: tenantId,
        input: {
          scope: "global",
          title: "Domain marker",
          body: "Marks the item's category as a domain.",
          tags: [`domain:${item.category}`],
          status: "active",
        },
      },
      tdb.db,
    );
    const { ctx } = toolContext(await newConversation());
    const read = getTool("get_intake_item");
    const propose = getTool("create_intake_proposal");
    if (!read || !propose) throw new Error("intake tools are not registered");
    const result = await read.execute(ctx, { id: item.id });
    const domainTarget = {
      name: `Knowledge · ${item.category}`,
      category: item.category,
      tags: [`domain:${item.category}`],
    };
    expect(result).toMatchObject({
      ok: true,
      data: {
        evidence: [
          {
            agent: "codex",
            repo: "example/repo",
            excerpt: "Domain target learning evidence",
          },
        ],
        evidence_total: 1,
        suggested_knowledge_target: domainTarget,
      },
    });
    const proposal = await propose.execute(ctx, {
      title: "Domain fact",
      body: "Keep the domain fact.",
      target: (result.data as { suggested_knowledge_target: unknown }).suggested_knowledge_target,
    });
    expect(proposal).toMatchObject({
      ok: true,
      data: { proposal: { revision: { target: domainTarget } } },
    });
  });

  test("an item outside any domain gets no suggested knowledge target", async () => {
    const item = await createIntakeItem(
      {
        tenant_id: tenantId,
        actor: { kind: "user", id: userId },
        client_request_id: nextUuid(),
        title: "Undomained clip",
        source_url: "https://example.test/undomained",
        captured_at: "2026-10-10T07:00:00.000Z",
        body: "Undomained clip source text",
        category: "undomained-clips",
      },
      tdb.db,
    );
    const { ctx } = toolContext(await newConversation());
    const read = getTool("get_intake_item");
    if (!read) throw new Error("intake tools are not registered");
    expect(await read.execute(ctx, { id: item.id })).toMatchObject({
      ok: true,
      data: { suggested_knowledge_target: null },
    });
  });

  test("proposal tools describe both destinations and admit neither", () => {
    for (const name of ["create_intake_proposal", "revise_intake_proposal"]) {
      const tool = getTool(name);
      if (!tool) throw new Error(`${name} is not registered`);
      expect(tool.description).toContain("knowledge or");
      expect(tool.description).toMatch(/admits no knowledge or skill/);
    }
    const create = getTool("create_intake_proposal");
    expect(create?.description).toContain("supersedes as {skill_id, expected_version}");
    expect(create?.description).toContain("suggested_knowledge_target");
    expect(getTool("get_intake_item")?.description).toContain("suggested_knowledge_target");
  });

  test("a locked review rejects an item the person did not select", async () => {
    const selected = await createItem("Selected source");
    const unselected = await createItem("Unselected source");
    const initial = {
      ...createEmptyDraftDocument(),
      session: { intake_item_ids: [selected.id], intake_review_locked: true },
    };
    const { ctx } = toolContext(await newConversation(), initial);
    const list = getTool("list_intake_items");
    const read = getTool("get_intake_item");
    const propose = getTool("create_intake_proposal");
    if (!list || !read || !propose) throw new Error("intake tools are not registered");

    const listed = await list.execute(ctx, { category: "research", state: "discarded" });
    expect(listed).toMatchObject({
      ok: true,
      data: { selected_only: true, selected_count: 1, items: [{ id: selected.id }] },
    });
    expect(await read.execute(ctx, { id: unselected.id })).toMatchObject({
      ok: false,
      data: { error: "intake_item_not_selected" },
    });
    expect(
      await propose.execute(ctx, {
        item_ids: [selected.id],
        title: "Unread selected source",
        body: "This must require an explicit source read.",
        target: { name: "Reviewed knowledge" },
      }),
    ).toMatchObject({ ok: false, data: { error: "intake_items_must_be_read" } });
    expect(await read.execute(ctx, { id: selected.id })).toMatchObject({ ok: true });
    expect(
      await propose.execute(ctx, {
        item_ids: [unselected.id],
        title: "Unselected source",
        body: "This must not be proposed.",
        target: { name: "Reviewed knowledge" },
      }),
    ).toMatchObject({ ok: false, data: { error: "intake_item_not_selected" } });
  });
});
