import { describe, expect, test } from "bun:test";
import { type AttentionItem, entrySnapshot } from "@/features/overview/model/attention-projection";
import {
  attentionSeenKey,
  createSeenStore,
  nextSeen,
  SEEN_MAX,
  seenStorageKey,
  unseenEntries,
} from "./attention-seen";

function item(id: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    class: "failing",
    severity: "urgent",
    kind: "workflow",
    subject: { kind: "workflow", id, name: id },
    reason: "failing",
    trigger: null,
    cause_class: null,
    counts: {},
    since: null,
    deadline: null,
    detail: null,
    actions: [],
    ...overrides,
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("attention seen model", () => {
  test("the identity follows id, class and reason but not counts", () => {
    const base = item("workflow:a");
    expect(attentionSeenKey(base)).toBe("workflow:a|failing|failing");
    expect(attentionSeenKey(item("workflow:a", { counts: { failures: 9 } }))).toBe(
      attentionSeenKey(base),
    );
    expect(attentionSeenKey(item("workflow:a", { class: "stopped" }))).not.toBe(
      attentionSeenKey(base),
    );
  });

  test("an unseeded store reports nothing new", () => {
    expect(unseenEntries(null, [item("workflow:a")])).toEqual([]);
  });

  test("a new id, class or reason is new, a counts-only change is not", () => {
    const seen = nextSeen(null, [item("workflow:a")], false);
    expect(unseenEntries(seen, [item("workflow:a", { counts: { failures: 2 } })])).toEqual([]);
    expect(unseenEntries(seen, [item("workflow:b")]).map((entry) => entry.id)).toEqual([
      "workflow:b",
    ]);
    expect(unseenEntries(seen, [item("workflow:a", { class: "stopped" })])).toHaveLength(1);
    expect(
      unseenEntries(seen, [item("workflow:a", { reason: "execution_authority_required" })]),
    ).toHaveLength(1);
  });

  test("hidden entries never count as new", () => {
    const fresh = item("workflow:b");
    const hidden = new Map([[fresh.id, entrySnapshot(fresh)]]);
    expect(unseenEntries(new Set(), [fresh], hidden)).toEqual([]);
  });

  test("marking replaces the set unless a source failed, then it keeps old keys", () => {
    const seen = nextSeen(null, [item("workflow:a")], false);
    expect([...nextSeen(seen, [item("workflow:b")], false)]).toEqual([
      "workflow:b|failing|failing",
    ]);
    expect([...nextSeen(seen, [item("workflow:b")], true)].sort()).toEqual([
      "workflow:a|failing|failing",
      "workflow:b|failing|failing",
    ]);
  });

  test("the seen set is capped and keeps the current entries", () => {
    const old = new Set(Array.from({ length: SEEN_MAX }, (_, index) => `old:${index}|x|y`));
    const next = nextSeen(old, [item("workflow:new")], true);
    expect(next.size).toBe(SEEN_MAX);
    expect(next.has("workflow:new|failing|failing")).toBeTrue();
  });

  test("the storage key is scoped to workspace and person", () => {
    expect(seenStorageKey("tenant-a", "user-1")).not.toBe(seenStorageKey("tenant-b", "user-1"));
    expect(seenStorageKey("tenant-a", "user-1")).not.toBe(seenStorageKey("tenant-a", "user-2"));
  });
});

describe("attention seen store", () => {
  const key = seenStorageKey("tenant-a", "user-1");

  test("reads, writes and keeps a stable snapshot", () => {
    const storage = memoryStorage();
    const store = createSeenStore(() => storage);
    expect(store.read(key)).toBeNull();
    store.write(key, new Set(["workflow:a|failing|failing"]));
    expect(store.read(key)).toBe(store.read(key));
    expect([...(store.read(key) ?? [])]).toEqual(["workflow:a|failing|failing"]);
    expect(storage.values.get(key)).toBe(JSON.stringify(["workflow:a|failing|failing"]));
    expect(store.read(seenStorageKey("tenant-b", "user-1"))).toBeNull();
  });

  test("corrupt storage reads as unseeded so the caller reseeds", () => {
    const storage = memoryStorage({ [key]: "{not json" });
    expect(createSeenStore(() => storage).read(key)).toBeNull();
    const wrongShape = memoryStorage({ [key]: JSON.stringify({ a: 1 }) });
    expect(createSeenStore(() => wrongShape).read(key)).toBeNull();
  });

  test("throwing or missing storage falls back to memory", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    for (const store of [createSeenStore(() => throwing), createSeenStore(() => null)]) {
      expect(store.read(key)).toBeNull();
      store.write(key, new Set(["workflow:a|failing|failing"]));
      expect([...(store.read(key) ?? [])]).toEqual(["workflow:a|failing|failing"]);
    }
  });

  test("a change from another tab notifies subscribers with the new value", () => {
    const storage = memoryStorage();
    const store = createSeenStore(() => storage);
    store.write(key, new Set(["workflow:a|failing|failing"]));
    let notified = 0;
    const stop = store.subscribe(() => {
      notified += 1;
    });
    storage.values.set(key, JSON.stringify(["workflow:b|failing|failing"]));
    store.external("unrelated");
    expect(notified).toBe(0);
    store.external(key);
    expect(notified).toBe(1);
    expect([...(store.read(key) ?? [])]).toEqual(["workflow:b|failing|failing"]);
    store.external(null);
    expect(notified).toBe(2);
    stop();
    store.write(key, new Set());
    expect(notified).toBe(2);
  });
});
