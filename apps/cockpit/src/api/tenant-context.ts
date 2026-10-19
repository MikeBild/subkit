let tenantId: string | null = null;

export function acceptTenantContext(id: string): boolean {
  if (tenantId !== null && tenantId !== id) return false;
  tenantId = id;
  return true;
}

export function tenantContextHeaders(): Record<string, string> {
  return tenantId ? { "x-subkit-tenant": tenantId } : {};
}

export function tenantContentHref(path: string): string {
  if (!tenantId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}tenant_context=${encodeURIComponent(tenantId)}`;
}

const contextListeners = new Set<() => void>();
let contextChanged = false;

export function tenantContextChanged(): boolean {
  return contextChanged;
}

export function onTenantContextChanged(listener: () => void): () => void {
  contextListeners.add(listener);
  return () => {
    contextListeners.delete(listener);
  };
}

export function noticeTenantContext(status: number, code: string | null): void {
  if (contextChanged || status !== 409 || code !== "tenant_context_changed") return;
  contextChanged = true;
  for (const listener of contextListeners) listener();
}

export function observeTenantSwitches(): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel("subkit-workspace-context");
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string" && tenantId !== null && event.data !== tenantId) {
      noticeTenantContext(409, "tenant_context_changed");
    }
  };
  return () => channel.close();
}

export function broadcastTenantSwitch(nextTenantId: string): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel("subkit-workspace-context");
  channel.postMessage(nextTenantId);
  channel.close();
}
