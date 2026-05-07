// Public API barrel for the `rbac` subsystem. Routes and other
// subsystems must import from this entry point only — see the
// route_layering check at apps/engine/scripts/audit-invariants.ts.

export * from "./catalog.ts";
export * from "./evaluator.ts";
export * from "./grants.ts";
export * from "./groups.ts";
export * from "./roles.ts";
export * from "./seed.ts";
export * from "./self-introspection.ts";
export * from "./ux-gating.ts";
