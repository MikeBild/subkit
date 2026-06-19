// Re-exports the canonical UX-gating permission list from
// `packages/shared/`. Engine routes import via `rbac/index.ts` for
// route-layering compliance; the literal lives one hop away in
// `@shared/ux-gating` so the CLI + tests + engine see the *same*
// `as const` tuple — drift between server and CLI is caught at
// typecheck instead of at the next test run.

export type { UxGatingPermission } from "@shared/ux-gating.ts";
export { UX_GATING_PERMISSIONS } from "@shared/ux-gating.ts";
