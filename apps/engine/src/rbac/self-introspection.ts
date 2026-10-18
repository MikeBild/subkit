export const SELF_INTROSPECTION_ROUTES = Object.freeze([
  "whoami",
  "identity-permissions",
  "sk-bootstrap",
  "cockpit-bootstrap",
  "identity-login",
  "identity-sessions",
  "identity-cli-session",
  "identity-providers",
  "health",
] as const);

export type SelfIntrospectionRoute = (typeof SELF_INTROSPECTION_ROUTES)[number];
