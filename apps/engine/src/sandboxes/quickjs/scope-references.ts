const JS_SCOPE_REF_PATTERNS = [
  /\binput\??\.scope\??\.([A-Za-z_$][A-Za-z0-9_$]*)/g,
  /\binput\??\.scope\[\s*["']([^"'\]]+)["']\s*\]/g,
];

const RESOLVED_SCOPE_ACCESS =
  /\binput\s*\??\.\s*scope\s*(?:\??\.\s*([A-Za-z_$][A-Za-z0-9_$]*)|\??\.?\[\s*["']([^"'\]]+)["']\s*\])/g;

const PROTOTYPE_SCOPE_ACCESS =
  /\binput\s*\??\.\s*scope\s*(?:\??\.\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:\?\.\s*)?\(|\??\.\s*(?:constructor|__proto__|prototype|toString|valueOf|hasOwnProperty|isPrototypeOf|propertyIsEnumerable|toLocaleString)\b)/;

const WORKFLOW_INPUT_ACCESS = /\binput\s*\??\.\s*input\b/g;

const UNRESOLVED_ACCESS =
  /\binput\b|\bscope\b|__sandbox_input__|\barguments\b|\beval\b|\bFunction\b|\bglobalThis\b/;

export function extractJsScopeReferences(code: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const re of JS_SCOPE_REF_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const id = m[1] ?? "";
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

export function resolveJsScopeReferences(code: string): string[] | null {
  if (PROTOTYPE_SCOPE_ACCESS.test(code)) return null;
  const ids = new Set<string>();
  const remainder = code
    .replace(
      RESOLVED_SCOPE_ACCESS,
      (_match, dotted: string | undefined, quoted: string | undefined) => {
        const id = dotted ?? quoted ?? "";
        if (id) ids.add(id);
        return " ";
      },
    )
    .replace(WORKFLOW_INPUT_ACCESS, " ");
  if (UNRESOLVED_ACCESS.test(remainder)) return null;
  return [...ids];
}

export function pruneScopeForJs(
  code: string,
  scope: Record<string, unknown>,
): { scope: Record<string, unknown>; pruned: boolean } {
  const ids = resolveJsScopeReferences(code);
  if (ids === null) return { scope, pruned: false };
  const pruned: Record<string, unknown> = {};
  for (const id of ids) {
    if (Object.hasOwn(scope, id)) pruned[id] = scope[id];
  }
  return { scope: pruned, pruned: true };
}
