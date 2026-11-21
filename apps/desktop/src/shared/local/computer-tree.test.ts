import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { maskSecureNodes, redactRects, secureFocus } from "@shared/local-policy/redaction-rects.ts";
import {
  findRef,
  focusPath,
  fullyObserved,
  labelHash,
  modelTree,
  nodeAt,
  type RawNode,
  RawNodeSchema,
  stateHash,
  toAxNode,
} from "./computer-tree.ts";

const PASSWORD: RawNode = {
  role: "textfield",
  name: "Password",
  ref_id: "@s1:e3",
  states: ["secure", "focused"],
  bounds: { x: 110, y: 220, width: 100, height: 20 },
};

const TREE: RawNode = {
  role: "window",
  name: "Login",
  bounds: { x: 100, y: 200, width: 400, height: 300 },
  children: [
    { role: "textfield", name: "User", value: "mike", ref_id: "@s1:e1", states: [] },
    {
      role: "group",
      children: [
        { role: "button", name: "Send", ref_id: "@s1:e2", description: "Sends it" },
        PASSWORD,
      ],
    },
  ],
};

describe("RawNodeSchema", () => {
  test("parses helper nodes and ignores unknown keys", () => {
    const parsed = RawNodeSchema.parse({
      role: "window",
      native_id: { kind: "ax_identifier", value: "x" },
      children: [{ role: "button", ref_id: null, value: null, available_actions: ["Click"] }],
    });
    expect(parsed.children?.[0]?.role).toBe("button");
  });

  test("rejects a node without role", () => {
    expect(RawNodeSchema.safeParse({ name: "x" }).success).toBe(false);
  });
});

describe("toAxNode", () => {
  test("maps the helper secure and focused states onto the policy core", () => {
    const node = toAxNode(PASSWORD);
    expect(node).toEqual({
      role: "textfield",
      label: "Password",
      value: null,
      ref: "@s1:e3",
      secure: true,
      focused: true,
      frame: PASSWORD.bounds ?? null,
      children: [],
    });
  });

  test("the policy core sees a focused secure textfield and its rectangle", () => {
    const ax = toAxNode(TREE);
    expect(secureFocus(ax)).toBe(true);
    const unfocused = toAxNode({ ...TREE, children: [{ ...PASSWORD, states: ["secure"] }] });
    expect(secureFocus(unfocused)).toBe(false);
    expect(redactRects(unfocused, { x: 100, y: 200, width: 400, height: 300 })).toEqual({
      ok: true,
      rects: [{ x: 8, y: 18, width: 104, height: 24 }],
    });
    expect(maskSecureNodes(unfocused).children?.[0]).toEqual({
      role: "password",
      label: "[password, hidden]",
      ref: null,
      children: [],
    });
  });

  test("missing fields map to null", () => {
    expect(toAxNode({ role: "group" })).toEqual({
      role: "group",
      label: null,
      value: null,
      ref: null,
      secure: false,
      focused: false,
      frame: null,
      children: [],
    });
  });
});

describe("modelTree", () => {
  test("hides secure nodes, their refs and values, and drops bounds", () => {
    expect(modelTree(TREE)).toEqual({
      role: "window",
      name: "Login",
      children: [
        { role: "textfield", name: "User", value: "mike", ref: "@s1:e1" },
        {
          role: "group",
          children: [
            { role: "button", name: "Send", ref: "@s1:e2" },
            { role: "password", name: "[password, hidden]" },
          ],
        },
      ],
    });
  });

  test("keeps states except secure and omits empty values", () => {
    expect(modelTree({ role: "checkbox", value: "", states: ["checked", "focused"] })).toEqual({
      role: "checkbox",
      states: ["checked", "focused"],
    });
    expect(modelTree({ role: "x", states: ["secure"], name: "" })).toEqual({
      role: "password",
      name: "[password, hidden]",
    });
  });
});

describe("focusPath and stateHash", () => {
  test("finds the child-index path of the focused node", () => {
    expect(focusPath(TREE)).toEqual([1, 1]);
    expect(focusPath({ role: "x", states: ["focused"] })).toEqual([]);
    expect(focusPath({ role: "x", children: [{ role: "y" }] })).toBeNull();
  });

  test("ignores values, bounds and refs", () => {
    const changed: RawNode = {
      ...TREE,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        { role: "textfield", name: "User", value: "other", ref_id: "@s9:e7", states: [] },
        TREE.children?.[1] as RawNode,
      ],
    };
    expect(stateHash(changed)).toBe(stateHash(TREE));
  });

  test("changes with structure, names, descriptions, states and focus", () => {
    const base = stateHash(TREE);
    expect(stateHash({ ...TREE, name: "Other" })).not.toBe(base);
    expect(stateHash({ ...TREE, role: "dialog" })).not.toBe(base);
    expect(stateHash({ ...TREE, description: "d" })).not.toBe(base);
    expect(stateHash({ ...TREE, states: ["disabled"] })).not.toBe(base);
    expect(stateHash({ ...TREE, children: [] })).not.toBe(base);
    const refocused: RawNode = {
      ...TREE,
      children: [
        { role: "textfield", name: "User", value: "mike", ref_id: "@s1:e1", states: ["focused"] },
        {
          role: "group",
          children: [
            TREE.children?.[1]?.children?.[0] as RawNode,
            { ...PASSWORD, states: ["secure"] },
          ],
        },
      ],
    };
    expect(stateHash(refocused)).not.toBe(base);
  });

  test("state order does not matter and the focus state only counts through the path", () => {
    expect(stateHash({ role: "x", states: ["b", "a"] })).toBe(
      stateHash({ role: "x", states: ["a", "b"] }),
    );
    expect(stateHash({ role: "x", states: ["focused"] })).not.toBe(stateHash({ role: "x" }));
  });

  test("is sha256 over the canonical form", () => {
    const expected = createHash("sha256")
      .update(JSON.stringify({ tree: ["x", "n", "d", ["a"], []], focus: null }), "utf8")
      .digest("hex");
    expect(stateHash({ role: "x", name: "n", description: "d", states: ["a"] })).toBe(expected);
  });
});

describe("findRef and nodeAt", () => {
  test("finds a ref with role, label and path", () => {
    expect(findRef(TREE, "@s1:e2")).toEqual({
      role: "button",
      label: "Send",
      secure: false,
      path: [1, 0],
    });
    expect(findRef(TREE, "@s1:e3")).toEqual({
      role: "textfield",
      label: "Password",
      secure: true,
      path: [1, 1],
    });
    expect(findRef({ role: "button", ref_id: "@s1:e1" }, "@s1:e1")).toEqual({
      role: "button",
      label: "",
      secure: false,
      path: [],
    });
    expect(findRef(TREE, "@s1:e9")).toBeNull();
  });

  test("reads the node at a path", () => {
    expect(nodeAt(TREE, [1, 0])?.name).toBe("Send");
    expect(nodeAt(TREE, [])).toBe(TREE);
    expect(nodeAt(TREE, [5])).toBeNull();
    expect(nodeAt(TREE, [0, 0, 0])).toBeNull();
  });
});

describe("fullyObserved", () => {
  test("a complete tree is observed", () => {
    expect(fullyObserved(TREE)).toBe(true);
    expect(fullyObserved({ role: "x", children_count: 1, children: [{ role: "y" }] })).toBe(true);
  });

  test("cut subtrees are not observed", () => {
    expect(fullyObserved({ role: "x", subtree_truncated: true })).toBe(false);
    expect(fullyObserved({ role: "x", children_count: 2, children: [{ role: "y" }] })).toBe(false);
    expect(fullyObserved({ role: "x", children_count: 1 })).toBe(false);
    expect(fullyObserved({ role: "x", children: [{ role: "y", subtree_truncated: true }] })).toBe(
      false,
    );
    expect(fullyObserved({ role: "x", subtree_truncated: false })).toBe(true);
  });
});

describe("labelHash", () => {
  test("keys the label with device, app and role", () => {
    const expected = createHash("sha256")
      .update("d\u0000b\u0000button\u0000Send", "utf8")
      .digest("hex");
    expect(labelHash("d", "b", "button", "Send")).toBe(expected);
    expect(labelHash("other", "b", "button", "Send")).not.toBe(expected);
  });
});

describe("tree edge cases", () => {
  test("native ids need a kind and a string value", () => {
    expect(
      RawNodeSchema.safeParse({ role: "x", native_id: { kind: "ax_identifier", value: "a" } })
        .success,
    ).toBe(true);
    expect(
      RawNodeSchema.safeParse({ role: "x", native_id: { kind: "ax_identifier" } }).success,
    ).toBe(false);
    expect(RawNodeSchema.safeParse({ role: "x", native_id: { value: "a" } }).success).toBe(false);
  });

  test("bounds must be numbers", () => {
    expect(
      RawNodeSchema.safeParse({ role: "x", bounds: { x: "a", y: 0, width: 1, height: 1 } }).success,
    ).toBe(false);
  });

  test("model nodes carry only present fields", () => {
    expect(modelTree({ role: "x", value: null })).toStrictEqual({ role: "x" });
    expect(modelTree({ role: "x" })).toStrictEqual({ role: "x" });
    expect(modelTree({ role: "x", value: "" })).toStrictEqual({ role: "x" });
  });

  test("the canonical form of a bare node", () => {
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    expect(stateHash({ role: "x" })).toBe(hash({ tree: ["x", "", "", [], []], focus: null }));
    expect(stateHash({ role: "x", states: ["focused", "b"] })).toBe(
      hash({ tree: ["x", "", "", ["b"], []], focus: [] }),
    );
  });
});
