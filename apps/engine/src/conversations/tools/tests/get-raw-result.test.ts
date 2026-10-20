import { afterEach, describe, expect, it } from "bun:test";
import { getRawResultTool } from "../get-raw-result.ts";
import { clearRawStore, rememberRaw, withRawResultScope } from "../truncate.ts";

afterEach(() => {
  clearRawStore();
});

describe("get_raw_result", () => {
  it("keeps a reference within its tenant, actor and conversation", async () => {
    const scope = {
      tenant_id: "tenant-a",
      conversation_id: "conversation-a",
      actor_id: "actor-a",
    };
    const ref = withRawResultScope(scope, () => rememberRaw({ private: "sample" }));

    expect(await getRawResultTool.execute(scope as never, { ref })).toEqual({
      ok: true,
      data: { raw: { private: "sample" } },
    });
    for (const changed of [
      { ...scope, tenant_id: "tenant-b" },
      { ...scope, conversation_id: "conversation-b" },
      { ...scope, actor_id: "actor-b" },
    ]) {
      expect(await getRawResultTool.execute(changed as never, { ref })).toMatchObject({
        ok: false,
        data: { error: "raw_ref_not_found" },
      });
    }
  });

  it("returns small prior results without changing their shape", async () => {
    const value = { item: { title: "Sample" } };
    const ref = rememberRaw(value);

    const result = await getRawResultTool.execute({} as never, { ref });

    expect(result).toEqual({ ok: true, data: { raw: value } });
  });

  it("streams oversized results through scoped reference-only chunks", async () => {
    const ref = rememberRaw({ item: { body: "a".repeat(320_000) } });

    const first = await getRawResultTool.execute({} as never, { ref });

    expect(first).toMatchObject({
      ok: true,
      data: {
        encoding: "json_fragment",
        offset: 0,
      },
    });
    const nextRef = (first.data as { next_ref: string }).next_ref;
    const second = await getRawResultTool.execute({} as never, { ref: nextRef });
    expect(second).toMatchObject({
      ok: true,
      data: { encoding: "json_fragment", offset: 4_000 },
    });
    expect(JSON.stringify(first).length).toBeLessThan(8_500);
  });

  it("reconstructs a complete result with only ref and keeps continuation scoped", async () => {
    const scope = {
      tenant_id: "tenant-a",
      conversation_id: "conversation-a",
      actor_id: "actor-a",
    };
    const value = { rows: Array.from({ length: 1_000 }, (_, id) => ({ id, title: `Row ${id}` })) };
    let ref: string | null = withRawResultScope(scope, () => rememberRaw(value));
    let serialized = "";
    while (ref !== null) {
      const result = await getRawResultTool.execute(scope as never, { ref });
      expect(result.ok).toBe(true);
      const data = result.data as { raw: string; next_ref: string | null };
      serialized += data.raw;
      if (data.next_ref) {
        expect(
          await getRawResultTool.execute({ ...scope, actor_id: "actor-b" } as never, {
            ref: data.next_ref,
          }),
        ).toMatchObject({ ok: false, data: { error: "raw_ref_not_found" } });
      }
      ref = data.next_ref;
    }
    expect(JSON.parse(serialized)).toEqual(value);
  });

  it("returns bounded Unicode string chunks with the next offset", async () => {
    const body = "ä😀b".repeat(20_000);
    const ref = rememberRaw({ item: { body } });

    const first = await getRawResultTool.execute({} as never, {
      ref,
      path: ["item", "body"],
      limit: 12_000,
    });
    const second = await getRawResultTool.execute({} as never, {
      ref,
      path: ["item", "body"],
      offset: 12_000,
      limit: 12_000,
    });

    expect(first).toMatchObject({
      ok: true,
      data: {
        raw: Array.from(body).slice(0, 12_000).join(""),
        total_chars: 60_000,
        next_offset: 12_000,
      },
    });
    expect(second).toMatchObject({
      ok: true,
      data: {
        raw: Array.from(body).slice(12_000, 24_000).join(""),
        total_chars: 60_000,
        next_offset: 24_000,
      },
    });
  });

  it("does not return values from missing references or paths", async () => {
    expect(await getRawResultTool.execute({} as never, { ref: "missing" })).toMatchObject({
      ok: false,
      data: { error: "raw_ref_not_found" },
    });

    const ref = rememberRaw({ item: { title: "Sample" } });
    expect(
      await getRawResultTool.execute({} as never, { ref, path: ["item", "body"] }),
    ).toMatchObject({
      ok: false,
      data: { error: "raw_result_path_not_found" },
    });
  });

  it("names the stored value's top-level keys when a path is not found", async () => {
    const ref = rememberRaw({ rows: [], meta: { total: 0 }, next_cursor: null });

    const result = await getRawResultTool.execute({} as never, { ref, path: ["data", "rows"] });

    expect(result).toEqual({
      ok: false,
      data: {
        error: "raw_result_path_not_found",
        path: ["data", "rows"],
        available_keys: ["rows", "meta", "next_cursor"],
      },
    });
  });

  it("reports the item count when the stored value is a list and a path is not found", async () => {
    const ref = rememberRaw([{ id: 1 }, { id: 2 }]);

    const result = await getRawResultTool.execute({} as never, { ref, path: ["items"] });

    expect(result).toEqual({
      ok: false,
      data: { error: "raw_result_path_not_found", path: ["items"], total_items: 2 },
    });
  });

  it("rejects chunk offsets beyond the available string", async () => {
    const ref = rememberRaw({ item: { body: "a".repeat(20_000) } });

    expect(
      await getRawResultTool.execute({} as never, {
        ref,
        path: ["item", "body"],
        offset: 20_001,
      }),
    ).toMatchObject({
      ok: false,
      data: { error: "raw_result_offset_out_of_range", offset: 20_001, total_chars: 20_000 },
    });
  });

  it("keeps path-based reads available for large fields inside arrays", async () => {
    const ref = rememberRaw([{ title: "Large", body: "a".repeat(320_000) }]);

    const result = await getRawResultTool.execute({} as never, {
      ref,
      path: [0, "body"],
      limit: 100,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        raw: "a".repeat(100),
        total_chars: 320_000,
        next_offset: 100,
      },
    });
  });
});
