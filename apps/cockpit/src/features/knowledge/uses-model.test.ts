import { describe, expect, it } from "bun:test";
import { boundTo, recordUses } from "./uses-model";

describe("uses of a source or skill", () => {
  it("knows its binding only when the scope names an id", () => {
    expect(boundTo({ scope: "workflow", workflowId: "w1" })).toEqual({
      kind: "workflow",
      id: "w1",
    });
    expect(boundTo({ scope: "connector", connectorId: "c1" })).toEqual({
      kind: "connector",
      id: "c1",
    });
    expect(boundTo({ scope: "workflow", workflowId: " " })).toBeNull();
    expect(boundTo({ scope: "global" })).toBeNull();
  });

  it("lists binding, inbox origins of this record and conversations, in that order", () => {
    const rows = recordUses({
      binding: { kind: "workflow", id: "w1" },
      bindingName: "Rechnungen",
      target: { kind: "skill", id: "s1" },
      intake: [
        { id: "i1", title: "Notiz", admitted_target_kind: "skill", admitted_target_id: "s1" },
        { id: "i2", title: "Fremd", admitted_target_kind: "skill", admitted_target_id: "s2" },
        { id: "i3", title: "Quelle", admitted_target_kind: "knowledge", admitted_target_id: "s1" },
      ],
      conversations: [
        { id: "c1", title: "Frage" },
        { id: "c2", title: null },
      ],
    });
    expect(rows.map((r) => [r.kind, r.name])).toEqual([
      ["workflow", "Rechnungen"],
      ["intake", "Notiz"],
      ["chat", "Frage"],
      ["chat", "…"],
    ]);
    expect(rows[0]?.href).toContain("w1");
    expect(rows[1]?.href).toContain("/intake/i1");
  });

  it("an unbound record without origins has no uses", () => {
    expect(
      recordUses({
        binding: null,
        bindingName: null,
        target: { kind: "knowledge", id: "k1" },
        intake: [],
        conversations: [],
      }),
    ).toEqual([]);
  });
});
