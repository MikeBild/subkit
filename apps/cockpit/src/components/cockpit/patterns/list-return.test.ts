import { describe, expect, test } from "bun:test";
import {
  LIST_RETURN_MAX_AGE_MS,
  type ListReturnStore,
  listReturnHref,
  readListReturn,
  rememberListReturn,
  settleListReturn,
} from "./list-return";

function memory(): ListReturnStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe("returning to a list", () => {
  test("the back link carries the filters the list had when a row was opened", () => {
    const store = memory();
    rememberListReturn(
      "/workflows",
      { search: "?category=devops&q=brief", scrollTop: 420, openedId: "wf-1" },
      1_000,
      store,
    );
    const entry = readListReturn("/workflows", 2_000, store);
    expect(entry).toEqual({
      search: "?category=devops&q=brief",
      scrollTop: 420,
      openedId: "wf-1",
      at: 1_000,
    });
    expect(listReturnHref("/workflows", entry)).toBe("/workflows?category=devops&q=brief");
    expect(listReturnHref("/connectors", readListReturn("/connectors", 2_000, store))).toBe(
      "/connectors",
    );
  });

  test("an old or malformed memory is ignored", () => {
    const store = memory();
    rememberListReturn("/files", { search: "", scrollTop: 0, openedId: "f" }, 0, store);
    expect(readListReturn("/files", LIST_RETURN_MAX_AGE_MS + 1, store)).toBeNull();
    store.setItem("sk.list-return:/files", "{nope");
    expect(readListReturn("/files", 1, store)).toBeNull();
    store.setItem(
      "sk.list-return:/files",
      JSON.stringify({ search: "javascript:x", scrollTop: 0, openedId: null, at: 0 }),
    );
    expect(readListReturn("/files", 1, store)).toBeNull();
  });

  test("the highlight is shown once; the filters stay for the next back link", () => {
    const store = memory();
    rememberListReturn(
      "/skills",
      { search: "?q=a", scrollTop: 10, openedId: "s" },
      Date.now(),
      store,
    );
    settleListReturn("/skills", store);
    expect(readListReturn("/skills", Date.now(), store)).toMatchObject({
      search: "?q=a",
      openedId: null,
    });
  });

  test("no storage means no memory and no error", () => {
    rememberListReturn("/intake", { search: "?x=1", scrollTop: 0, openedId: null }, 0, null);
    expect(readListReturn("/intake", 0, null)).toBeNull();
    const broken: ListReturnStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    rememberListReturn("/intake", { search: "", scrollTop: 0, openedId: null }, 0, broken);
    expect(readListReturn("/intake", 0, broken)).toBeNull();
  });
});
