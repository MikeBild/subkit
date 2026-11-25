export const PIN_RULE = "must be one plain path segment of letters, digits, _ or -";

export type InstallInputPin =
  | { readonly ok: true; readonly definition: unknown }
  | { readonly ok: false; readonly key: string; readonly message: string };

export const pinnableInstallInput = (value: unknown): string | null => {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(text) ? text : null;
};

const pinPath = (path: unknown, values: ReadonlyMap<string, string>): unknown =>
  typeof path === "string"
    ? [...values].reduce(
        (pinned, [key, value]) => pinned.replaceAll(`\${input.${key}}`, value),
        path,
      )
    : path;

export function pinInstallInputs(
  definition: unknown,
  keys: readonly string[],
  inputs: Readonly<Record<string, unknown>>,
): InstallInputPin {
  const values = new Map<string, string>();
  for (const key of keys.filter((declared) => Object.hasOwn(inputs, declared))) {
    const value = pinnableInstallInput(inputs[key]);
    if (value === null) return { ok: false, key, message: `install input ${key} ${PIN_RULE}` };
    values.set(key, value);
  }
  if (values.size === 0) return { ok: true, definition };
  const shape = definition as { steps?: unknown };
  const steps = Array.isArray(shape.steps)
    ? shape.steps.map((step: Record<string, unknown>) =>
        step?.kind !== "request"
          ? step
          : {
              ...step,
              ...("path" in step ? { path: pinPath(step.path, values) } : {}),
              ...("url" in step ? { url: pinPath(step.url, values) } : {}),
            },
      )
    : shape.steps;
  return { ok: true, definition: { ...shape, steps } };
}
