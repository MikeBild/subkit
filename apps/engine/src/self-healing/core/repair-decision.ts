export type SignalSource = "reactive" | "proactive_scheduler" | "proactive_admin" | "proactive_mcp";

export type ExistingRepairDecision =
  | Readonly<{ kind: "repropose" }>
  | Readonly<{ kind: "return_applied" }>
  | Readonly<{ kind: "refresh" }>;

export function decideExistingRepair(
  facts: Readonly<{
    status: "applied" | "proposed" | "rejected" | "superseded" | "inapplicable";
    source: SignalSource;
  }>,
): ExistingRepairDecision {
  if (facts.status === "applied")
    return facts.source === "reactive" ? { kind: "repropose" } : { kind: "return_applied" };
  return { kind: "refresh" };
}
