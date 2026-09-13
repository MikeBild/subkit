import type * as prompts from "@clack/prompts";
import { describe, expect, test } from "bun:test";

import { pickId } from "../lib/pick.ts";

const noRows = async () => [];

describe("pickId", () => {
  test("returns argValue untouched when supplied (no fetch, no prompt)", async () => {
    let fetched = false;
    const id = await pickId({
      label: "connector id",
      argValue: "conn-123",
      fetch: async () => {
        fetched = true;
        return [];
      },
    });
    expect(id).toBe("conn-123");
    expect(fetched).toBe(false);
  });

  test("non-TTY without argValue throws the canonical required error", async () => {
    await expect(pickId({ label: "connector id", fetch: noRows, isTTY: false })).rejects.toThrow(
      "connector id is required",
    );
  });

  test("TTY path resolves via the injected select implementation", async () => {
    let seenMessage = "";
    let seenOptions: ReadonlyArray<{ value: string; label?: string }> = [];
    const id = await pickId({
      label: "workflow id",
      fetch: async () => [
        { id: "wf-aaaaaaaa-1111", name: "Daily report", detail: "daily-report" },
        { id: "wf-bbbbbbbb-2222", name: null, detail: null },
      ],
      isTTY: true,
      selectImpl: (async (opts: {
        message: string;
        options: ReadonlyArray<{ value: string; label?: string }>;
      }) => {
        seenMessage = opts.message;
        seenOptions = opts.options;
        return "wf-bbbbbbbb-2222";
      }) as typeof prompts.select,
    });
    expect(id).toBe("wf-bbbbbbbb-2222");
    expect(seenMessage).toBe("Select a workflow id");
    expect(seenOptions.map((o) => o.value)).toEqual(["wf-aaaaaaaa-1111", "wf-bbbbbbbb-2222"]);
    // Row labels join name, (detail), and the 8-char id prefix.
    expect(seenOptions[0]?.label).toBe("Daily report (daily-report) wf-aaaaa");
    expect(seenOptions[1]?.label).toBe("wf-bbbbb");
  });

  test("cancel symbol from select throws the required error", async () => {
    // @clack/prompts signals Ctrl-C via a private cancel symbol. pickId
    // guards with `isCancel(choice) || typeof choice !== "string"`, so
    // any symbol (cancel included) resolves to the required error, not
    // a hang or a symbol leaking out as an "id".
    const cancelled = Symbol("clack:cancel");
    await expect(
      pickId({
        label: "execution id",
        fetch: async () => [{ id: "exec-1" }],
        isTTY: true,
        selectImpl: (async () => cancelled) as unknown as typeof prompts.select,
      }),
    ).rejects.toThrow("execution id is required");
  });

  test("TTY with zero candidate rows throws without prompting", async () => {
    await expect(
      pickId({
        label: "connector id",
        fetch: noRows,
        isTTY: true,
        selectImpl: (async () => {
          throw new Error("select must not be called with no rows");
        }) as unknown as typeof prompts.select,
      }),
    ).rejects.toThrow("connector id is required (no candidates found to pick from)");
  });
});
