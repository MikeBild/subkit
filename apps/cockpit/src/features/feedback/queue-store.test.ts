import { describe, expect, test } from "bun:test";
import { memoryQueueStore, queueStore } from "./queue-store";

describe("feedback queue storage", () => {
  test("the memory store keeps what was saved and hands out copies", async () => {
    const store = memoryQueueStore<{ id: string }>();
    await store.save([{ id: "a" }]);
    const items = await store.load();
    items.push({ id: "b" });
    expect(await store.load()).toEqual([{ id: "a" }]);
  });

  test("without IndexedDB, as in a test or a locked-down window, it falls back to memory", async () => {
    const store = queueStore<{ id: string }>("feedback", null);
    expect(store.kind).toBe("memory");
    await store.save([{ id: "a" }]);
    expect(await store.load()).toEqual([{ id: "a" }]);
  });

  test("an IndexedDB that refuses to open still keeps the queue in memory", async () => {
    const broken = {
      open() {
        throw new Error("blocked");
      },
    } as unknown as IDBFactory;
    const store = queueStore<{ id: string }>("feedback", broken);
    await store.save([{ id: "a" }]);
    expect(await store.load()).toEqual([{ id: "a" }]);
  });
});
