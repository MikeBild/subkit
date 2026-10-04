// Typecheck-time invariant: every slash command's `requires:` must be
// a member of `UX_GATING_PERMISSIONS` (the canonical bootstrap-probe
// set in `@shared/ux-gating`).
//
// **Why this exists**: when a
// slash declares `requires: "connector:write"` but `connector:write`
// is NOT in `UX_GATING_PERMISSIONS`, the bootstrap response never
// probes that permission, the persona's `allowed` Set never contains
// it, and `slashCommandsForPersona` filters the slash out for
// EVERY user — including admins. A previous version of the registry
// had this exact drift for `connector:write`, `notification:write`,
// and `discovery:read`, silently hiding 8+ commands.
//
// **What to do when the assignment in `slash.ts` fails to compile**:
// the failing position references a `SlashCommand.requires` literal
// that isn't on the canonical list. Two valid responses:
//   1. Add the permission to `packages/shared/src/ux-gating.ts` so
//      admins see the slash.
//   2. Drop the `requires:` field from the slash entry if the
//      permission is genuinely outside the bootstrap probe set.
//
// **Why this file is type-only**: the
// initial extraction also moved the runtime assignment here, but
// `slash.ts → slash-permissions-invariant.ts → slash.ts` was a
// runtime cycle that crashed at module load (`Cannot access
// 'SLASH_COMMANDS' before initialization`). Splitting into a
// type-only export here + the runtime assignment in `slash.ts`
// keeps the explainer where a future reader can find it without
// breaking module init order.

import type { UxGatingPermission } from "@shared/ux-gating.ts";

type _SlashRequiresMember<T> = T extends { requires: infer R }
  ? R extends UxGatingPermission
    ? T
    : never
  : T;

/** Mapped type: walks every entry in the registry and substitutes
 *  `never` for any whose `requires:` literal isn't a
 *  `UxGatingPermission`. The runtime assignment in `slash.ts`
 *  pins the registry to this shape — when an entry's mapped
 *  position is `never`, the assignment fails to compile. */
export type AssertSlashRequiresAreInUxGating<C extends readonly unknown[]> = {
  [K in keyof C]: _SlashRequiresMember<C[K]>;
};
