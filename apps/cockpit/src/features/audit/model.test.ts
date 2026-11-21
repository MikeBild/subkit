import { describe, expect, it } from "bun:test";
import { auditKind, auditQuery, auditTone, highlightedEntry } from "./model";

describe("audit", () => {
  it("approvals and grants win over the resource type", () => {
    expect(auditKind({ action: "task.authority_granted", resource_type: "task" })).toBe("approval");
    expect(auditKind({ action: "execution.approved", resource_type: "execution" })).toBe(
      "approval",
    );
  });
  it("maps resource types to kinds and unknown ones to server", () => {
    expect(auditKind({ action: "execution.started", resource_type: "execution" })).toBe("run");
    expect(auditKind({ action: "connector.updated", resource_type: "connector" })).toBe(
      "connector",
    );
    expect(auditKind({ action: "conversation.created", resource_type: "conversation" })).toBe(
      "chat",
    );
    expect(auditKind({ action: "intake.admitted", resource_type: "intake_item" })).toBe("inbox");
    expect(auditKind({ action: "something", resource_type: "mystery" })).toBe("server");
  });
  it("denied and failed records are red, otherwise the kind's tone", () => {
    expect(
      auditTone({ action: "execution.started", resource_type: "execution", result: "error" }),
    ).toBe("danger");
    expect(
      auditTone({ action: "execution.started", resource_type: "execution", result: "success" }),
    ).toBe("success");
    expect(
      auditTone({ action: "connector.updated", resource_type: "connector", result: "success" }),
    ).toBe("warning");
  });
  it("forwards link filters and known ids from the address", () => {
    const q = auditQuery(
      "?result=denied&workflow_id=w1&ignored=x",
      { resource_type: "workflow", action: "a,b" },
      { resource_types: "execution" },
    );
    expect(q).toEqual({
      resource_types: "execution",
      resource_type: "workflow",
      result: "denied",
      workflow_id: "w1",
      action: "a,b",
    });
  });
  it("reads the highlighted entry id and rejects odd values", () => {
    expect(highlightedEntry("?entry=0b6a1f2c-1111-2222-3333-444455556666")).toBe(
      "0b6a1f2c-1111-2222-3333-444455556666",
    );
    expect(highlightedEntry("?entry=<script>")).toBeNull();
    expect(highlightedEntry("")).toBeNull();
  });
});
