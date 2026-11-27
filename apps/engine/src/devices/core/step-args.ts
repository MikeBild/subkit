import type { DeviceSubBoundary } from "@shared/device/boundary.ts";
import { SCROLL_DIRECTIONS } from "@shared/device/browser.ts";
import { COMPUTER_SCROLL_DIRECTIONS } from "@shared/device/computer.ts";
import { type ElementTarget, ElementTargetSchema } from "@shared/device/element-target.ts";
import { FILES_BATCH_MAX, FileContentSchema } from "@shared/device/files.ts";
import { capabilityOfKind, type DeviceCommandKind } from "@shared/device/protocol.ts";
import { z } from "zod";
import { commandEffect } from "./offline-policy.ts";

export const LOCAL_STEP_KINDS = [
  "files.list",
  "files.read_text",
  "files.import",
  "files.write",
  "files.mkdir",
  "files.move",
  "files.trash",
  "browser.open",
  "browser.snapshot",
  "browser.press",
  "browser.fill",
  "browser.wait",
  "browser.extract",
  "browser.screenshot",
  "browser.download",
  "browser.sign_in",
  "browser.pay",
  "computer.apps",
  "computer.snapshot",
  "computer.screenshot",
  "computer.press",
  "computer.focus",
  "computer.select",
  "computer.set_value",
  "computer.type",
  "computer.key",
  "computer.scroll",
] as const satisfies readonly DeviceCommandKind[];
export type LocalStepKind = (typeof LOCAL_STEP_KINDS)[number];

const RUNNABLE: ReadonlySet<string> = new Set(LOCAL_STEP_KINDS);

export const STEP_ARGS_REFUSALS = [
  "kind_not_ready",
  "local_method_mismatch",
  "local_step_invalid",
  "outside_boundary",
] as const;
export type StepArgsRefusal = (typeof STEP_ARGS_REFUSALS)[number];

export interface StepArgsInput {
  kind: DeviceCommandKind;
  method: string;
  body: unknown;
  boundary: DeviceSubBoundary | null;
  partition: string;
}

export interface StepArgsPlan {
  kind: LocalStepKind;
  args: Record<string, unknown>;
  element: ElementTarget | null;
  app_id: string | null;
  fields?: Readonly<Record<string, ElementTarget>>;
}

export const VAULT_STEP_KINDS: ReadonlySet<string> = new Set(["browser.sign_in", "browser.pay"]);

export type StepArgsResult =
  | { ok: true; plan: StepArgsPlan }
  | { ok: false; code: StepArgsRefusal; detail: string };

const path = z.string().max(4096);
const folderId = z.string().min(1).max(200);
const element = ElementTargetSchema;
const appId = z.string().min(1).max(255);

const FolderBody = z.object({ folder_id: folderId, path: path.default("") }).strict();
const ImportBody = z
  .object({ folder_id: folderId, path, name: z.string().min(1).max(255).optional() })
  .strict();
const WriteBody = z
  .object({
    folder_id: folderId,
    path: path.min(1),
    content: z.union([z.string(), FileContentSchema]),
    replace: z.boolean().default(false),
  })
  .strict();
const MoveItem = z.object({ from: path.min(1), to: path.min(1) }).strict();
const MoveBody = z
  .object({
    folder_id: folderId,
    to_folder_id: folderId.optional(),
    path: path.min(1).optional(),
    to_path: path.min(1).optional(),
    items: z.array(MoveItem).min(1).max(FILES_BATCH_MAX).optional(),
  })
  .strict()
  .refine(
    (body) =>
      (body.items === undefined) === (body.path !== undefined && body.to_path !== undefined),
    {
      message: "name either path and to_path or items",
    },
  );
const TrashBody = z
  .object({
    folder_id: folderId,
    path: path.min(1).optional(),
    paths: z.array(path.min(1)).min(1).max(FILES_BATCH_MAX).optional(),
  })
  .strict()
  .refine((body) => (body.path === undefined) !== (body.paths === undefined), {
    message: "name either path or paths",
  });

const Empty = z.object({}).strict();
const OpenBody = z.object({ url: z.string().min(1).max(4096) }).strict();
const PressBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), element }).strict(),
  z.object({ action: z.literal("key"), key: z.string().regex(/^[A-Za-z0-9+]{1,32}$/) }).strict(),
  z
    .object({
      action: z.literal("scroll"),
      direction: z.enum(SCROLL_DIRECTIONS),
      pixels: z.number().int().min(1).max(10_000).optional(),
    })
    .strict(),
]);
const FillBody = z.discriminatedUnion("mode", [
  z.object({ mode: z.enum(["fill", "type"]), element, text: z.string().max(10_000) }).strict(),
  z
    .object({
      mode: z.literal("select"),
      element,
      values: z.array(z.string().max(1000)).min(1).max(50),
    })
    .strict(),
]);
const WaitBody = z.discriminatedUnion("for", [
  z
    .object({
      for: z.literal("load"),
      state: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
    })
    .strict(),
  z.object({ for: z.literal("text"), text: z.string().min(1).max(1000) }).strict(),
  z.object({ for: z.literal("ms"), ms: z.number().int().min(1).max(30_000) }).strict(),
]);
const ExtractBody = z.object({ element: element.optional() }).strict();
const DownloadBody = z
  .object({ element, folder_id: folderId, name: z.string().min(1).max(255) })
  .strict();

const origin = z.string().min(1).max(2048);
const SIGN_IN_FIELDS = ["username", "password", "code", "submit"] as const;
const PAY_FIELDS = ["number", "exp", "exp_month", "exp_year", "holder", "cvv", "submit"] as const;
const VAULT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "browser.sign_in": SIGN_IN_FIELDS,
  "browser.pay": PAY_FIELDS,
};
const SignInBody = z
  .object({
    origin,
    vault_item: z.string().min(1).max(200),
    kind: z.enum(["password", "totp"]).optional(),
    username: element.optional(),
    password: element.optional(),
    code: element.optional(),
    submit: element.optional(),
  })
  .strict()
  .refine((body) => SIGN_IN_FIELDS.some((field) => body[field] !== undefined), {
    message: "name at least one of username, password, code or submit",
  });
const PayBody = z
  .object({
    origin,
    card: z.string().min(1).max(200),
    amount_minor: z.number().int().min(1).max(100_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    number: element,
    exp: element.optional(),
    exp_month: element.optional(),
    exp_year: element.optional(),
    holder: element.optional(),
    cvv: element.optional(),
    submit: element,
  })
  .strict();

function vaultFields(kind: string, body: Body): Record<string, ElementTarget> {
  return Object.fromEntries(
    (VAULT_FIELDS[kind] ?? []).flatMap((field) =>
      body[field] === undefined ? [] : [[field, body[field] as ElementTarget]],
    ),
  );
}

const AppBody = z.object({ app_id: appId }).strict();
const AppElementBody = AppBody.extend({ element }).strict();
const BODIES: Record<LocalStepKind, z.ZodType> = {
  "files.list": FolderBody,
  "files.read_text": FolderBody,
  "files.mkdir": FolderBody,
  "files.import": ImportBody,
  "files.write": WriteBody,
  "files.move": MoveBody,
  "files.trash": TrashBody,
  "browser.open": OpenBody,
  "browser.snapshot": Empty,
  "browser.screenshot": Empty,
  "browser.press": PressBody,
  "browser.fill": FillBody,
  "browser.wait": WaitBody,
  "browser.extract": ExtractBody,
  "browser.download": DownloadBody,
  "browser.sign_in": SignInBody,
  "browser.pay": PayBody,
  "computer.apps": Empty,
  "computer.snapshot": AppBody,
  "computer.screenshot": AppBody,
  "computer.key": AppBody.extend({ keys: z.string().min(1).max(64) }).strict(),
  "computer.press": AppElementBody,
  "computer.focus": AppElementBody,
  "computer.select": AppElementBody.extend({ option: z.string().min(1).max(500) }).strict(),
  "computer.set_value": AppElementBody.extend({ value: z.string() }).strict(),
  "computer.type": AppElementBody.extend({ text: z.string() }).strict(),
  "computer.scroll": AppElementBody.extend({
    direction: z.enum(COMPUTER_SCROLL_DIRECTIONS),
    amount: z.number().int().min(1).max(20),
  }).strict(),
};

interface FolderUse {
  folder_id: string;
  writes: boolean;
}

const FOLDER_READ_KINDS: ReadonlySet<string> = new Set([
  "files.list",
  "files.read_text",
  "files.import",
]);

type Body = Record<string, unknown>;

function target(folder_id: string, at: string) {
  return { folder_id, path: at };
}

function filesArgs(kind: LocalStepKind, body: Body): Record<string, unknown> {
  const folder = body.folder_id as string;
  switch (kind) {
    case "files.write": {
      const content = body.content as string | z.infer<typeof FileContentSchema>;
      return {
        target: target(folder, body.path as string),
        content: typeof content === "string" ? { encoding: "utf8", text: content } : content,
        replace: body.replace,
      };
    }
    case "files.move": {
      const to = (body.to_folder_id as string | undefined) ?? folder;
      const items = (body.items as { from: string; to: string }[] | undefined) ?? [
        { from: body.path as string, to: body.to_path as string },
      ];
      return {
        items: items.map((item) => ({ from: target(folder, item.from), to: target(to, item.to) })),
      };
    }
    case "files.trash": {
      const paths = (body.paths as string[] | undefined) ?? [body.path as string];
      return { items: paths.map((at) => target(folder, at)) };
    }
    case "files.import":
      return {
        target: target(folder, body.path as string),
        ...(body.name === undefined ? {} : { name: body.name }),
      };
    default:
      return { target: target(folder, body.path as string) };
  }
}

function browserArgs(kind: LocalStepKind, body: Body): Record<string, unknown> {
  if (VAULT_STEP_KINDS.has(kind)) {
    const fields = VAULT_FIELDS[kind] ?? [];
    return Object.fromEntries(Object.entries(body).filter(([key]) => !fields.includes(key)));
  }
  const { element: _element, ...rest } = body;
  if (body.action === "scroll") return { ...rest, pixels: body.pixels ?? 600 };
  if (body.for === "load") return { ...rest, state: body.state ?? "load" };
  return rest;
}

function computerArgs(body: Body): Record<string, unknown> {
  const { element: _element, app_id: _app, ...rest } = body;
  return rest;
}

function folderUses(kind: LocalStepKind, body: Body): FolderUse[] {
  if (typeof body.folder_id !== "string") return [];
  const uses: FolderUse[] = [{ folder_id: body.folder_id, writes: !FOLDER_READ_KINDS.has(kind) }];
  if (typeof body.to_folder_id === "string")
    uses.push({ folder_id: body.to_folder_id, writes: true });
  return uses;
}

function coverage(kind: LocalStepKind, body: Body, boundary: DeviceSubBoundary): string | null {
  for (const use of folderUses(kind, body)) {
    const bound = boundary.folders?.find((entry) => entry.folder_id === use.folder_id);
    if (!bound) return `The folder ${use.folder_id} is not part of this workflow's approval.`;
    if (use.writes && bound.access !== "write")
      return `The approval lets this workflow only read the folder ${use.folder_id}.`;
  }
  const capability = capabilityOfKind(kind);
  if (capability === "browser") {
    if (!boundary.sites || boundary.sites.length === 0)
      return "This workflow's approval names no website for this device.";
    const named = typeof body.url === "string" ? body.url : body.origin;
    if (typeof named === "string") {
      const origin = URL.parse(named)?.origin;
      if (!boundary.sites.some((site) => site.origin === origin))
        return "This website is not part of this workflow's approval.";
    }
  }
  if (typeof body.app_id === "string" && !boundary.apps?.some((app) => app.app_id === body.app_id))
    return "This app is not part of this workflow's approval.";
  return null;
}

function refused(
  code: StepArgsRefusal,
  detail: string,
): { ok: false; code: StepArgsRefusal; detail: string } {
  return { ok: false, code, detail };
}

function issueText(error: z.ZodError): string {
  const [issue] = error.issues as [z.core.$ZodIssue];
  return issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

export type ParsedLocalStep =
  | { ok: true; plan: StepArgsPlan; body: Record<string, unknown> }
  | { ok: false; code: StepArgsRefusal; detail: string };

export function parseLocalStep(input: Omit<StepArgsInput, "boundary">): ParsedLocalStep {
  if (!RUNNABLE.has(input.kind))
    return refused("kind_not_ready", "This device can't run this kind of step yet.");
  const kind = input.kind as LocalStepKind;
  const reads = commandEffect(kind) === "read";
  if (reads !== (input.method.toUpperCase() === "GET"))
    return refused(
      "local_method_mismatch",
      reads
        ? "This step only reads, so it uses GET."
        : "This step changes something, so it can't use GET.",
    );
  const parsed = BODIES[kind].safeParse(input.body ?? {});
  if (!parsed.success) return refused("local_step_invalid", issueText(parsed.error));
  const body = parsed.data as Body;
  const capability = capabilityOfKind(kind);
  const args =
    capability === "files"
      ? filesArgs(kind, body)
      : capability === "browser"
        ? { ...browserArgs(kind, body), partition: input.partition }
        : computerArgs(body);
  return {
    ok: true,
    body,
    plan: {
      kind,
      args,
      element: (body.element as ElementTarget | undefined) ?? null,
      app_id: typeof body.app_id === "string" ? body.app_id : null,
      ...(VAULT_STEP_KINDS.has(kind) ? { fields: vaultFields(kind, body) } : {}),
    },
  };
}

export function localStepArgs(input: StepArgsInput): StepArgsResult {
  const parsed = parseLocalStep(input);
  if (!parsed.ok) return parsed;
  const { plan, body } = parsed;
  const boundary = input.boundary;
  if (!boundary || boundary.capability !== capabilityOfKind(plan.kind))
    return refused("outside_boundary", "This step is not part of an approval for this device.");
  const uncovered = coverage(plan.kind, body, boundary);
  if (uncovered !== null) return refused("outside_boundary", uncovered);
  return { ok: true, plan: { ...plan, args: { ...plan.args, boundary } } };
}

export function argsWithRef(
  plan: Pick<StepArgsPlan, "args">,
  pick: { ref: string; window_id?: string; state_hash?: string },
): Record<string, unknown> {
  return {
    ...plan.args,
    ...(pick.window_id === undefined ? {} : { window_id: pick.window_id }),
    ref: pick.ref,
    ...(pick.state_hash === undefined ? {} : { state_hash: pick.state_hash }),
  };
}

interface ManifestDeviceEffect {
  step_id?: unknown;
  call_path?: unknown;
  device?: DeviceSubBoundary;
}

export function approvedBoundary(
  manifest: unknown,
  step_id: string,
  device_id: string,
  capability: DeviceSubBoundary["capability"],
): DeviceSubBoundary | null {
  const effects = Object(manifest).effects;
  if (!Array.isArray(effects)) return null;
  const own = (effects as ManifestDeviceEffect[]).flatMap((effect) =>
    effect.call_path === undefined &&
    effect.device?.device_id === device_id &&
    effect.device.capability === capability
      ? [{ step_id: effect.step_id, device: effect.device }]
      : [],
  );
  const bound = own.find((effect) => effect.step_id === step_id)?.device;
  if (!bound) return null;
  const sites = new Map<string, NonNullable<DeviceSubBoundary["sites"]>[number]>();
  for (const effect of own)
    for (const site of effect.device.sites ?? []) sites.set(site.origin, site);
  if (sites.size === 0) return bound;
  return {
    ...bound,
    sites: [...sites.keys()]
      .sort()
      .map((origin) => sites.get(origin) as NonNullable<DeviceSubBoundary["sites"]>[number]),
  };
}

export function windowFor(appsOutput: unknown, app_id: string): string | null {
  const windows = Object(appsOutput).windows;
  if (!Array.isArray(windows)) return null;
  const own = windows
    .map(
      (entry) => Object(entry) as { window_id?: unknown; bundle_id?: unknown; focused?: unknown },
    )
    .filter(
      (entry): entry is { window_id: string; focused?: unknown } =>
        entry.bundle_id === app_id && typeof entry.window_id === "string",
    );
  const chosen = own.find((entry) => entry.focused === true) ?? own[0];
  return chosen?.window_id ?? null;
}

export function argsWithWindow(
  plan: Pick<StepArgsPlan, "args">,
  window_id: string,
): Record<string, unknown> {
  return { ...plan.args, window_id };
}
