import { ALLOWED_HOST_RULE, canonicalHostList } from "./allowed-hosts.ts";

export const PIN_RULE = "must be one plain path segment of letters, digits, _ or -";
export const MAILBOX_RULE = "must be one plain email address of the sending mailbox";

export type InstallInputPin =
  | { readonly ok: true; readonly definition: unknown }
  | {
      readonly ok: false;
      readonly key: string;
      readonly missing: boolean;
      readonly rule: string;
      readonly message: string;
    };

export const installInputMailbox = (key: string) => `${key}@install-input.invalid`;

const MAILBOX =
  /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;

type Step = Record<string, unknown>;

export const pinnableInstallInput = (value: unknown): string | null => {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(text) ? text : null;
};

const mailbox = (value: unknown): string | null =>
  typeof value === "string" && value.length <= 254 && MAILBOX.test(value) ? value : null;

const pinPath = (path: unknown, values: ReadonlyMap<string, string>): unknown =>
  typeof path === "string"
    ? [...values].reduce(
        (pinned, [key, value]) => pinned.replaceAll(`\${input.${key}}`, value),
        path,
      )
    : path;

const stepsOf = (definition: unknown): Step[] => {
  const steps = (definition as { steps?: unknown } | null)?.steps;
  return Array.isArray(steps) ? (steps as Step[]) : [];
};

const deliveryOf = (step: Step): Record<string, unknown> | null =>
  step?.kind === "request" &&
  step.transactional_delivery !== null &&
  typeof step.transactional_delivery === "object"
    ? (step.transactional_delivery as Record<string, unknown>)
    : null;

export function mailboxInstallInputs(definition: unknown, keys: readonly string[]): string[] {
  const senders = new Set(stepsOf(definition).map((step) => deliveryOf(step)?.from));
  return keys.filter((key) => senders.has(installInputMailbox(key)));
}

const pinMailboxes = (step: Step, values: ReadonlyMap<string, string>): Step => {
  const delivery = deliveryOf(step);
  if (delivery) {
    const sender = [...values].find(([key]) => delivery.from === installInputMailbox(key));
    return sender ? { ...step, transactional_delivery: { ...delivery, from: sender[1] } } : step;
  }
  if (step?.kind !== "transform" || typeof step.expression !== "string") return step;
  return {
    ...step,
    expression: [...values].reduce(
      (expression, [key, value]) =>
        expression
          .replaceAll(`'${installInputMailbox(key)}'`, `'${value}'`)
          .replaceAll(`"${installInputMailbox(key)}"`, `"${value}"`),
      step.expression,
    ),
  };
};

const pinHosts = (boundary: unknown, lists: ReadonlyMap<string, string[]>): unknown => {
  if (boundary === null || typeof boundary !== "object" || Array.isArray(boundary)) return boundary;
  const hosts = (boundary as { allowed_hosts?: unknown }).allowed_hosts;
  const key = typeof hosts === "string" ? /^\$\{input\.([A-Za-z0-9_]+)\}$/.exec(hosts)?.[1] : null;
  const list = key ? lists.get(key) : undefined;
  return list ? { ...boundary, allowed_hosts: list } : boundary;
};

const refused = (key: string, missing: boolean, rule: string): InstallInputPin => ({
  ok: false,
  key,
  missing,
  rule,
  message: missing
    ? `install input ${key} is required: it ${rule}`
    : `install input ${key} ${rule}`,
});

export function pinInstallInputs(
  definition: unknown,
  keys: readonly string[],
  inputs: Readonly<Record<string, unknown>>,
  inputDefinition: unknown = definition,
): InstallInputPin {
  const mailboxKeys = new Set(mailboxInstallInputs(inputDefinition, keys));
  const paths = new Map<string, string>();
  const senders = new Map<string, string>();
  const lists = new Map<string, string[]>();
  for (const key of keys) {
    const given = Object.hasOwn(inputs, key);
    if (mailboxKeys.has(key)) {
      if (!given) return refused(key, true, MAILBOX_RULE);
      const value = mailbox(inputs[key]);
      if (value === null) return refused(key, false, MAILBOX_RULE);
      senders.set(key, value);
      continue;
    }
    if (!given) continue;
    if (Array.isArray(inputs[key])) {
      const hosts = canonicalHostList(inputs[key]);
      if (hosts === null) return refused(key, false, ALLOWED_HOST_RULE);
      lists.set(key, hosts);
      continue;
    }
    const value = pinnableInstallInput(inputs[key]);
    if (value === null) return refused(key, false, PIN_RULE);
    paths.set(key, value);
  }
  if (paths.size === 0 && senders.size === 0 && lists.size === 0) return { ok: true, definition };
  const shape = definition as { steps?: unknown };
  const steps = Array.isArray(shape.steps)
    ? shape.steps.map((step: Step) => {
        const withSender = senders.size > 0 ? pinMailboxes(step, senders) : step;
        return withSender?.kind !== "request" || (paths.size === 0 && lists.size === 0)
          ? withSender
          : {
              ...withSender,
              ...("path" in withSender ? { path: pinPath(withSender.path, paths) } : {}),
              ...("url" in withSender ? { url: pinPath(withSender.url, paths) } : {}),
              ...("boundary" in withSender
                ? { boundary: pinHosts(withSender.boundary, lists) }
                : {}),
            };
      })
    : shape.steps;
  return { ok: true, definition: { ...shape, steps } };
}
