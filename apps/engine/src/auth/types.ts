export type PrincipalKind = "user" | "system_account";

export type AllowList = string[] | "all";

export type ExecutionAuthSource =
  | { kind: "api_key"; api_key_id: string; credential_version: string }
  | { kind: "browser_session"; session_id: string }
  | { kind: "mcp_oauth"; access_token_id: string; client_id: string }
  | {
      kind: "token_exchange";
      api_key_id: string;
      credential_version: string;
      expires_at: string;
    }
  | {
      kind: "external_bearer";
      provider_id: string;
      identity_id: string;
      issued_at: string;
      expires_at: string;
    };

export interface ResolvedPrincipal {
  provider: string;
  auth_source?: ExecutionAuthSource;
  kind: PrincipalKind;
  id: string;
  tenant_id: string;
  product_id?: string;
  roles: string[];
  api_key_id?: string;
  session_id?: string;
  oauth_client_id?: string;
  scopes?: string[];
  allowed_workflows?: AllowList;
  allowed_connectors?: AllowList;
  email?: string;
  subject?: string;
  via?: "token_exchange";
}

export interface AuthDenial {
  denied: true;
  provider: string;
  reason: string;
}

export function isAuthDenial(value: unknown): value is AuthDenial {
  return (
    typeof value === "object" && value !== null && (value as { denied?: unknown }).denied === true
  );
}

export interface AuthProviderCapabilities {
  human: boolean;
  machine: boolean;
  interactive: boolean;
  refresh: boolean;
  revoke: boolean;
}

export interface AuthProvider {
  readonly name: string;
  readonly capabilities: AuthProviderCapabilities;
  resolve(req: Request): Promise<ResolvedPrincipal | null>;
  startLogin?(req: Request): Promise<Response>;
  finishLogin?(req: Request): Promise<Response>;
  refreshSession?(req: Request): Promise<Response>;
  revoke?(req: Request): Promise<Response>;
}

export interface DenyingAuthProvider extends Omit<AuthProvider, "resolve"> {
  resolve(req: Request): Promise<ResolvedPrincipal | AuthDenial | null>;
  claims(req: Request): boolean;
}

export type RegisteredAuthProvider = AuthProvider | DenyingAuthProvider;

export interface PolicyContext {
  principal: ResolvedPrincipal;
  method: string;
  path: string;
  resource_kind?: string;
  resource_id?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}
