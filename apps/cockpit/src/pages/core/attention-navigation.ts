export type ReviewTarget =
  | { kind: "workflow"; workflowId: string }
  | { kind: "skills" }
  | { kind: "other" };

export type ReviewAccess = "readable" | "not_permitted" | "nothing";

export type ReviewAction = Readonly<{ verb: string; href?: string | null }>;

export function reviewTarget(id: string): ReviewTarget {
  if (id === "skills") return { kind: "skills" };
  const match = /^workflow:([0-9a-f-]{36})$/i.exec(id);
  if (match?.[1]) return { kind: "workflow", workflowId: match[1] };
  return { kind: "other" };
}

export function reviewAccess(target: ReviewTarget, permissions: readonly string[]): ReviewAccess {
  if (target.kind === "workflow")
    return permissions.includes("workflow:read") ? "readable" : "not_permitted";
  if (target.kind === "skills")
    return permissions.includes("skill:read") ? "readable" : "not_permitted";
  return "nothing";
}

export function opensReviewSheet(
  item: Readonly<{ id: string }>,
  action: ReviewAction,
  hasReviewLink: (href: string) => boolean,
): boolean {
  return (
    action.verb === "review" &&
    (reviewTarget(item.id).kind !== "other" || (action.href ? hasReviewLink(action.href) : false))
  );
}

export function reviewForward<T extends ReviewAction>(
  action: T | null,
  access: ReviewAccess,
  hasReviewLink: (href: string) => boolean,
): T | null {
  if (!action?.href) return null;
  if (action.verb !== "review") return action;
  if (access !== "nothing" || hasReviewLink(action.href)) return null;
  return action;
}

export function reviewSettles(
  review: Readonly<{
    openBefore: number | null;
    openNow: number;
    listedBefore: boolean;
    listedNow: boolean;
  }>,
): boolean {
  if (review.openNow > 0) return false;
  if (review.openBefore !== null && review.openBefore > 0) return true;
  return review.listedBefore && !review.listedNow;
}
