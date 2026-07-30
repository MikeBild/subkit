// Public API barrel for the `connectors` subsystem. Routes and other
// subsystems must import from this entry point only — see the
// route_layering check at apps/engine/scripts/audit-invariants.ts.

export * from "./categorize.ts";
export * from "./config-schemas.ts";
export * from "./credential-setup-grant.ts";
export * from "./discovery/service.ts";
export * from "./discovery/types.ts";
export * from "./drivers/index.ts";
export * from "./health.ts";
export * from "./health-state.ts";
export * from "./oauth-html.ts";
export * from "./oauth-scope-diff.ts";
export * from "./oauth-start.ts";
export * from "./oauth-start-grant.ts";
export * from "./promotion.ts";
export * from "./reauth.ts";
export * from "./service.ts";
export * from "./services/call-connector.ts";
export * from "./template-binding.ts";
export * from "./template-credentials.ts";
// `ConnectorTemplateSource` is the canonical zod-derived type in
// `types.ts`; the duplicate `type` declaration in
// `template-resolver.ts` is the same shape. Re-exporting only the
// non-conflicting names avoids TS2308 from `export *` picking up
// both.
export {
  buildTemplateBindingFields,
  findTemplateAliasMatches,
  listResolvedConnectorTemplates,
  materializeConnectorTemplateRow,
  parseTemplateSnapshot,
  type ResolvedConnectorTemplate,
  resolveConnectorTemplate,
} from "./template-resolver.ts";
export * from "./template-url-match.ts";
export * from "./templates.ts";
export * from "./types.ts";
