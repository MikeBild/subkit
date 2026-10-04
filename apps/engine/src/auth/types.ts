export type PrincipalKind = "user" | "system_account";

export type AllowList = string[] | "all";

export interface ResolvedPrincipal {
  provider: string;
  kind: PrincipalKind;
  id: string;
  tenant_id: string;
  roles: string[];
  api_key_id?: string;
  session_id?: string;
  oauth_client_id?: string;
  scopes?: string[];
  allowed_workflows?: AllowList;
  allowed_connectors?: AllowList;
  email?: string;
  via?: "token_exchange";
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
