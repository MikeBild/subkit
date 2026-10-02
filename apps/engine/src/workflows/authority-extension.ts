// When an approval is close enough to its end that someone should extend it.
//
// One place for both readers: the attention list raises an item on these
// thresholds, and the cockpit offers "extend" on the same ones
// (`apps/cockpit/src/lib/automation-state.ts`, pinned to this file by its test).

/** An approval is worth extending this many days before it ends … */
export const AUTHORITY_EXTEND_WITHIN_DAYS = 3;
/** … or once less than this share of its runs is left. */
export const AUTHORITY_EXTEND_BELOW_RUN_SHARE = 0.1;
