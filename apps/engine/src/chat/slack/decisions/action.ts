export type DecisionVerb = "approve" | "decline";
export type DecisionKind = "tool_approval";

export interface DecisionAction {
  verb: DecisionVerb;
  kind: DecisionKind;
  subject_id: string;
}

const DECIDE =
  /^sk_decide:(approve|decline):(tool_approval):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const OPEN = /^sk_open:[a-z_]{1,32}:[A-Za-z0-9_.-]{1,64}$/;

export function decisionActionId(verb: DecisionVerb, kind: DecisionKind, subject_id: string) {
  return `sk_decide:${verb}:${kind}:${subject_id}`;
}

export function openActionId(kind: string, subject_id: string): string {
  return `sk_open:${kind}:${subject_id}`;
}

export function parseDecisionAction(action_id: string): DecisionAction | null {
  const match = DECIDE.exec(action_id);
  if (!match) return null;
  return {
    verb: match[1] as DecisionVerb,
    kind: match[2] as DecisionKind,
    subject_id: match[3] as string,
  };
}

export function isOpenAction(action_id: string): boolean {
  return OPEN.test(action_id);
}

export function isSlackDecisionAction(action_id: string): boolean {
  return action_id.startsWith("sk_decide:") || action_id.startsWith("sk_open:");
}
