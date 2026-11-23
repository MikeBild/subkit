import { z } from "@hono/zod-openapi";
import { HandoverReasonSchema } from "@shared/device/browser.ts";
import type { DeviceCapability, DeviceCommandKind } from "@shared/device/protocol.ts";

export const BECAUSE_FIELD = z
  .string()
  .max(400)
  .optional()
  .describe(
    "Only for an action that sends, saves, books, orders or changes something: quote the person's own words that ask for exactly this, verbatim. Omit it for reading and routine steps.",
  );

const SNAPSHOT_ID = z
  .string()
  .min(1)
  .max(100)
  .describe("The snapshot_id of the snapshot you took right before this action.");

const BROWSER_REF = z
  .string()
  .regex(/^@?e[0-9]{1,6}$/)
  .describe("A ref from that snapshot, like e12.");

const COMPUTER_REF = z
  .string()
  .regex(/^@s[a-z0-9]{1,64}:e[1-9][0-9]{0,6}$/)
  .describe("A ref from the latest window snapshot, like @s1a2b:e7.");

const WINDOW_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);

const ABSOLUTE_PATH = z
  .string()
  .min(2)
  .max(4096)
  .describe("An absolute path on the device, like /Users/anna/Documents/report.txt.");

export type RefKind = "browser" | "computer" | null;

export interface DeviceToolSpec {
  readonly name: string;
  readonly capability: DeviceCapability;
  readonly kind: DeviceCommandKind;
  readonly ref: RefKind;
  readonly description: string;
  readonly input: z.ZodObject;
}

const CHECK_BEFORE_REPEAT =
  " If a step fails with delivery_uncertain, the input may have reached the page or app: read it (snapshot or extract) before you repeat the step, never repeat it blindly.";

function spec(
  name: string,
  capability: DeviceCapability,
  kind: DeviceCommandKind,
  ref: RefKind,
  description: string,
  shape: z.ZodRawShape,
): DeviceToolSpec {
  return { name, capability, kind, ref, description, input: z.object(shape).strict() };
}

export const DEVICE_TOOL_SPECS: readonly DeviceToolSpec[] = [
  spec(
    "browser_open",
    "browser",
    "browser.open",
    null,
    "Open a web address in the separate SubKit browser on the person's device.",
    { url: z.string().min(1).max(4096) },
  ),
  spec(
    "browser_snapshot",
    "browser",
    "browser.snapshot",
    null,
    "Read the open page as a list of controls with refs. Take a new snapshot before every action that uses a ref: refs change with every snapshot.",
    {},
  ),
  spec(
    "browser_press",
    "browser",
    "browser.press",
    "browser",
    "Click a control (action click, with ref and snapshot_id), press a key (action key) or scroll (action scroll)." +
      CHECK_BEFORE_REPEAT,
    {
      action: z.enum(["click", "key", "scroll"]),
      ref: BROWSER_REF.optional(),
      snapshot_id: SNAPSHOT_ID.optional(),
      key: z
        .string()
        .regex(/^[A-Za-z0-9+]{1,32}$/)
        .optional(),
      direction: z.enum(["up", "down", "left", "right"]).optional(),
      because: BECAUSE_FIELD,
    },
  ),
  spec(
    "browser_fill",
    "browser",
    "browser.fill",
    "browser",
    "Type text into a field, or choose options in a select field. SubKit never types into password, one-time code or card fields." +
      CHECK_BEFORE_REPEAT,
    {
      ref: BROWSER_REF,
      snapshot_id: SNAPSHOT_ID,
      mode: z.enum(["fill", "type", "select"]).default("fill"),
      text: z.string().max(10_000).optional(),
      values: z.array(z.string().max(1000)).min(1).max(50).optional(),
      because: BECAUSE_FIELD,
    },
  ),
  spec(
    "browser_wait",
    "browser",
    "browser.wait",
    null,
    "Wait for the page to load, for a text to appear or for some milliseconds.",
    {
      for: z.enum(["load", "text", "ms"]),
      text: z.string().min(1).max(1000).optional(),
      ms: z.number().int().min(1).max(30_000).optional(),
    },
  ),
  spec(
    "browser_extract",
    "browser",
    "browser.extract",
    "browser",
    "Read the text of the page, or of one element (ref plus snapshot_id).",
    { ref: BROWSER_REF.optional(), snapshot_id: SNAPSHOT_ID.optional() },
  ),
  spec(
    "browser_screenshot",
    "browser",
    "browser.screenshot",
    null,
    "Take a redacted screenshot of the open page for the live view.",
    {},
  ),
  spec(
    "browser_handover",
    "browser",
    "browser.handover",
    null,
    "Pause and hand the browser to the person for a step only they should do, such as signing in or a captcha. Returns once they hand back.",
    { reason: HandoverReasonSchema },
  ),
  spec(
    "computer_handover",
    "computer",
    "computer.handover",
    null,
    "Pause and hand the Mac to the person for a step only they should do. Returns once they hand back.",
    { reason: HandoverReasonSchema },
  ),
  spec(
    "computer_apps",
    "computer",
    "computer.apps",
    null,
    "List the windows of allowed apps on the person's Mac.",
    {},
  ),
  spec(
    "computer_snapshot",
    "computer",
    "computer.snapshot",
    null,
    "Read one window as a tree of controls with refs. Take a new snapshot before every action: refs belong to one snapshot.",
    { window_id: WINDOW_ID },
  ),
  spec(
    "computer_screenshot",
    "computer",
    "computer.screenshot",
    null,
    "Take a redacted screenshot of one window for the live view.",
    { window_id: WINDOW_ID },
  ),
  spec(
    "computer_press",
    "computer",
    "computer.press",
    "computer",
    `Press a control in the window.${CHECK_BEFORE_REPEAT}`,
    { ref: COMPUTER_REF, because: BECAUSE_FIELD },
  ),
  spec("computer_focus", "computer", "computer.focus", "computer", "Focus a control.", {
    ref: COMPUTER_REF,
  }),
  spec(
    "computer_select",
    "computer",
    "computer.select",
    "computer",
    `Choose an option in a control.${CHECK_BEFORE_REPEAT}`,
    { ref: COMPUTER_REF, option: z.string().min(1).max(500), because: BECAUSE_FIELD },
  ),
  spec(
    "computer_set_value",
    "computer",
    "computer.set_value",
    "computer",
    `Set the value of a field.${CHECK_BEFORE_REPEAT}`,
    { ref: COMPUTER_REF, value: z.string().max(131_072), because: BECAUSE_FIELD },
  ),
  spec(
    "computer_type",
    "computer",
    "computer.type",
    "computer",
    `Type text into a field.${CHECK_BEFORE_REPEAT}`,
    {
      ref: COMPUTER_REF,
      text: z.string().max(10_000),
      because: BECAUSE_FIELD,
    },
  ),
  spec(
    "computer_key",
    "computer",
    "computer.key",
    "computer",
    "Press a key combination in the window of the latest snapshot, like cmd+s." +
      CHECK_BEFORE_REPEAT,
    { window_id: WINDOW_ID, keys: z.string().min(1).max(64), because: BECAUSE_FIELD },
  ),
  spec("computer_scroll", "computer", "computer.scroll", "computer", "Scroll inside a control.", {
    ref: COMPUTER_REF,
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(20).default(3),
  }),
  spec("files_list", "files", "files.list", null, "List a folder on the person's device.", {
    path: ABSOLUTE_PATH,
  }),
  spec("files_read", "files", "files.read_text", null, "Read a text file on the device.", {
    path: ABSOLUTE_PATH,
  }),
  spec(
    "files_write",
    "files",
    "files.write",
    null,
    "Write a text file. An existing file is replaced only with replace true; its previous version goes to the Trash.",
    {
      path: ABSOLUTE_PATH,
      text: z.string().max(10 * 1024 * 1024),
      replace: z.boolean().default(false),
      because: BECAUSE_FIELD,
    },
  ),
  spec("files_mkdir", "files", "files.mkdir", null, "Create a folder.", {
    path: ABSOLUTE_PATH,
    because: BECAUSE_FIELD,
  }),
  spec("files_move", "files", "files.move", null, "Move or rename a file or folder.", {
    from: ABSOLUTE_PATH,
    to: ABSOLUTE_PATH,
    because: BECAUSE_FIELD,
  }),
  spec(
    "files_trash",
    "files",
    "files.trash",
    null,
    "Move a file or folder to the Trash. Nothing is deleted.",
    { path: ABSOLUTE_PATH, because: BECAUSE_FIELD },
  ),
];

export const CLASSIFY_ACTION: Readonly<Record<string, string>> = {
  browser_press: "click",
  browser_fill: "fill",
  computer_press: "click",
  computer_select: "select",
  computer_set_value: "fill",
  computer_type: "fill",
  computer_key: "key",
};

export const DEVICE_TOOL_NAMES: ReadonlySet<string> = new Set(
  DEVICE_TOOL_SPECS.map((tool) => tool.name),
);

export function deviceToolSpec(name: string): DeviceToolSpec | null {
  return DEVICE_TOOL_SPECS.find((tool) => tool.name === name) ?? null;
}

export function isSnapshotTool(name: string): boolean {
  return name === "browser_snapshot" || name === "computer_snapshot";
}

export function browserPartition(owner: { kind: "task" | "chat"; id: string }): string {
  return `${owner.kind === "task" ? "t" : "c"}-${owner.id.toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(
    0,
    64,
  );
}

type Input = Record<string, unknown>;

function text(input: Input, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function defined(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

function browserArgs(name: string, input: Input, partition: string): Record<string, unknown> {
  switch (name) {
    case "browser_open":
      return { partition, url: input.url };
    case "browser_press":
      return defined({
        partition,
        action: input.action,
        ...(input.action === "click" ? { ref: input.ref } : {}),
        ...(input.action === "key" ? { key: input.key } : {}),
        ...(input.action === "scroll" ? { direction: input.direction } : {}),
      });
    case "browser_fill":
      return input.mode === "select"
        ? { partition, mode: "select", ref: input.ref, values: input.values }
        : { partition, mode: input.mode, ref: input.ref, text: input.text ?? "" };
    case "browser_wait":
      return defined({
        partition,
        for: input.for,
        ...(input.for === "text" ? { text: input.text } : {}),
        ...(input.for === "ms" ? { ms: input.ms } : {}),
      });
    case "browser_extract":
      return defined({ partition, ref: input.ref });
    case "browser_handover":
      return { partition, reason: input.reason };
    default:
      return { partition };
  }
}

function computerArgs(name: string, input: Input, state_hash: string | null): Input {
  const hash = state_hash === null ? {} : { state_hash };
  switch (name) {
    case "computer_apps":
      return {};
    case "computer_handover":
      return { reason: input.reason };
    case "computer_snapshot":
    case "computer_screenshot":
      return { window_id: input.window_id };
    case "computer_key":
      return { window_id: input.window_id, keys: input.keys, ...hash };
    default:
      return defined({
        window_id: input.window_id,
        ref: input.ref,
        ...hash,
        option: input.option,
        value: input.value,
        text: input.text,
        direction: input.direction,
        amount: input.amount,
      });
  }
}

function filesArgs(name: string, input: Input): Input {
  const target = (key: string) => ({ absolute: text(input, key) });
  switch (name) {
    case "files_write":
      return {
        target: target("path"),
        content: { encoding: "utf8", text: input.text },
        replace: input.replace === true,
      };
    case "files_move":
      return { items: [{ from: target("from"), to: target("to") }] };
    case "files_trash":
      return { items: [target("path")] };
    default:
      return { target: target("path") };
  }
}

export interface ArgsContext {
  readonly partition: string;
  readonly window_id: string | null;
  readonly state_hash: string | null;
}

export function commandArgsOf(tool: DeviceToolSpec, input: Input, context: ArgsContext): Input {
  if (tool.capability === "browser") return browserArgs(tool.name, input, context.partition);
  if (tool.capability === "computer")
    return computerArgs(
      tool.name,
      { ...input, window_id: input.window_id ?? context.window_id ?? undefined },
      context.state_hash,
    );
  return filesArgs(tool.name, input);
}
