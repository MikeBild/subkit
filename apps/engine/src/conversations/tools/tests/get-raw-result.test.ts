import { afterEach, describe, expect, it } from "bun:test";
import { getRawResultTool } from "../get-raw-result.ts";
import { clearRawStore, rememberRaw } from "../truncate.ts";

afterEach(() => {
  clearRawStore();
});

describe("get_raw_result", () => {
  it("returns small prior results without changing their shape", async () => {
    const value = { item: { title: "Sample" } };
    const ref = rememberRaw(value);

    const result = await getRawResultTool.execute({} as never, { ref });

    expect(result).toEqual({ ok: true, data: { raw: value } });
  });

  it("requires a path for oversized results instead of returning them whole", async () => {
    const ref = rememberRaw({ item: { body: "a".repeat(320_000) } });

    const result = await getRawResultTool.execute({} as never, { ref });

    expect(result).toMatchObject({
      ok: false,
      data: {
        error: "raw_result_too_large",
        fields: [{ path: ["item", "body"], chars: 320_000 }],
      },
    });
    expect(JSON.stringify(result).length).toBeLessThan(1_000);
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

  it("points to a large field inside an array instead of returning the whole item", async () => {
    const ref = rememberRaw([{ title: "Large", body: "a".repeat(320_000) }]);

    const result = await getRawResultTool.execute({} as never, { ref });

    expect(result).toMatchObject({
      ok: false,
      data: {
        error: "raw_result_too_large",
        fields: [{ path: [0, "body"], chars: 320_000 }],
      },
    });
    expect(JSON.stringify(result).length).toBeLessThan(1_000);
  });
});
