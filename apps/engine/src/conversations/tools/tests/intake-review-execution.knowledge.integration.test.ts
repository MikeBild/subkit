import { describe, expect, test } from "bun:test";
import { upsertKnowledgeBundle } from "../../../knowledge/bundle-service.ts";
import { patchIntakeItem } from "../../../knowledge/index.ts";
import { createEmptyDraftDocument } from "../../authoring-state/index.ts";
import { getTool } from "../index.ts";
import {
  createItem,
  newConversation,
  nextUuid,
  tdb,
  tenantId,
  toolContext,
  useIntakeReviewExecutionSetup,
  userId,
} from "./intake-review-execution-fixtures.ts";

useIntakeReviewExecutionSetup();

describe("proposals against existing knowledge in a locked review", () => {
  async function reviewOf(...items: Array<{ id: string }>) {
    const initial = {
      ...createEmptyDraftDocument(),
      session: { intake_item_ids: items.map((item) => item.id), intake_review_locked: true },
    };
    const { ctx } = toolContext(await newConversation(), initial);
    const read = getTool("get_intake_item");
    const propose = getTool("create_intake_proposal");
    if (!read || !propose) throw new Error("intake tools are not registered");
    for (const item of items) await read.execute(ctx, { id: item.id });
    return { ctx, propose };
  }

  async function bundle(name: string) {
    return (
      await upsertKnowledgeBundle(
        {
          tenant_id: tenantId,
          actor: { kind: "user", id: userId },
          input: { name },
          files: [{ path: "/reference.md", content: `# ${name}\n` }],
        },
        tdb.db,
      )
    ).knowledge_source;
  }

  test("a bundle id alone gets the current version", async () => {
    const source = await bundle("Extendable reference");
    const item = await createItem("Item for an existing bundle");
    const { ctx, propose } = await reviewOf(item);
    expect(
      await propose.execute(ctx, {
        title: "Extend the reference",
        body: "Added fact.",
        target: { knowledge_source_id: source.id },
      }),
    ).toMatchObject({
      ok: true,
      data: {
        proposal: {
          revision: {
            target: { knowledge_source_id: source.id, expected_version: source.version },
          },
        },
      },
    });
  });

  test("a stale version names the current one", async () => {
    const source = await bundle("Versioned reference");
    const item = await createItem("Item for a stale version");
    const { ctx, propose } = await reviewOf(item);
    const result = await propose.execute(ctx, {
      title: "Extend",
      body: "Added fact.",
      target: { knowledge_source_id: source.id, expected_version: "not-the-version" },
    });
    expect(result).toMatchObject({
      ok: false,
      error_code: "knowledge_target_changed",
      data: { current_version: source.version },
    });
  });

  test("an intake item id used as a knowledge source id is called out", async () => {
    const item = await createItem("Item mistaken for a source");
    const { ctx, propose } = await reviewOf(item);
    const result = await propose.execute(ctx, {
      title: "Extend",
      body: "Added fact.",
      target: { knowledge_source_id: item.id },
    });
    expect(result).toMatchObject({ ok: false, error_code: "knowledge_source_not_found" });
    expect((result as { message: string }).message).toContain("intake item id");
    expect(result).toMatchObject({ next_best_actions: ["list_knowledge_sources"] });
  });

  test("an unknown knowledge source id points to the list", async () => {
    const item = await createItem("Item for an unknown source");
    const { ctx, propose } = await reviewOf(item);
    const result = await propose.execute(ctx, {
      title: "Extend",
      body: "Added fact.",
      target: { knowledge_source_id: nextUuid() },
    });
    expect(result).toMatchObject({ ok: false, error_code: "knowledge_source_not_found" });
    expect((result as { message: string }).message).toContain("list_knowledge_sources");
  });

  test("a source id in item_ids names the selected items and the right field", async () => {
    const source = await bundle("Source mistaken for an item");
    const item = await createItem("The only selected item");
    const { ctx, propose } = await reviewOf(item);
    const result = await propose.execute(ctx, {
      item_ids: [source.id],
      title: "Extend",
      body: "Added fact.",
      target: { name: "Reviewed knowledge" },
    });
    expect(result).toMatchObject({
      ok: false,
      error_code: "intake_item_not_selected",
      data: { selected_item_ids: [item.id], rejected_ids: [source.id] },
    });
    expect((result as { message: string }).message).toContain("target.knowledge_source_id");
  });

  test("a decided item goes to a normal chat instead of a proposal", async () => {
    const item = await createItem("Item decided before the proposal");
    const { ctx, propose } = await reviewOf(item);
    await patchIntakeItem(
      {
        tenant_id: tenantId,
        actor: { kind: "user", id: userId },
        id: item.id,
        expected_version: item.version,
        state: "discarded",
      },
      tdb.db,
    );
    const result = await propose.execute(ctx, {
      title: "Too late",
      body: "Decided already.",
      target: { name: "Reviewed knowledge" },
    });
    expect(result).toMatchObject({ ok: false, error_code: "intake_item_already_admitted" });
    expect((result as { message: string }).message).toContain("normal chat");
  });

  test("the list shows what is needed to extend a source", async () => {
    const source = await bundle("Listed reference");
    const { ctx } = toolContext(await newConversation());
    const list = getTool("list_knowledge_sources");
    if (!list) throw new Error("list_knowledge_sources is not registered");
    const result = await list.execute(ctx, {});
    const entry = (result.data as { sources: Array<Record<string, unknown>> }).sources.find(
      (candidate) => candidate.id === source.id,
    );
    expect(entry).toMatchObject({ source_type: "bundle", version: source.version });
  });
});
