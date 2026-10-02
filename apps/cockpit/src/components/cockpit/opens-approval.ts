/**
 * The marker on every element that opens a workflow's approval dialog.
 *
 * An action exists once per view (UI-UX.md, "Action hierarchy"): the visual
 * stands count the visible elements that carry this marker and fail when a
 * view offers the approval from more than one of them.
 */
export const OPENS_APPROVAL = { "data-opens": "workflow-approval" } as const;
