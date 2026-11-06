const OWN_CREDENTIAL_REDACTION = "***redacted***";

function encodedForms(secret: string): string[] {
  const form = new URLSearchParams({ v: secret }).toString().slice(2);
  return [secret, encodeURIComponent(secret), form, JSON.stringify(secret).slice(1, -1)];
}

function ownCredentialForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    for (const form of encodedForms(secret)) forms.add(form);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function redactOwnCredentialText(text: string, forms: readonly string[]): string {
  let out = text;
  for (const form of forms) out = out.split(form).join(OWN_CREDENTIAL_REDACTION);
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function redactOwnCredentials<T>(value: T, secrets: readonly string[]): T {
  const forms = ownCredentialForms(secrets);
  if (forms.length === 0) return value;
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") return redactOwnCredentialText(current, forms);
    if (Array.isArray(current)) return current.map(walk);
    if (current instanceof Error) {
      current.message = redactOwnCredentialText(current.message, forms);
      return current;
    }
    if (isPlainRecord(current)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) out[key] = walk(item);
      return out;
    }
    return current;
  };
  return walk(value) as T;
}
