import { join } from "node:path";
import type { DeviceSubBoundary } from "@shared/device/boundary.ts";
import {
  BrowserDownloadArgsSchema,
  type BrowserExtractArgs,
  BrowserExtractArgsSchema,
  type BrowserFillArgs,
  BrowserFillArgsSchema,
  BrowserOpenArgsSchema,
  BrowserPageArgsSchema,
  type BrowserPressArgs,
  BrowserPressArgsSchema,
  type BrowserStep,
  type BrowserWaitArgs,
  BrowserWaitArgsSchema,
} from "@shared/device/browser.ts";
import type {
  DeviceCommand,
  DeviceCommandKind,
  DeviceEvidence,
  DeviceRefusal,
  DeviceResult,
} from "@shared/device/protocol.ts";
import { isCredentialField } from "@shared/local-policy/commit-classifier.ts";
import {
  CLOSED_RULES,
  downloadAllowed,
  type ProxySiteRules,
  requestTarget,
  targetAllowed,
} from "@shared/local-policy/proxy-decision.ts";
import type { z } from "zod";
import {
  type BrowserAllowances,
  FIELD_SCAN_SCRIPT,
  type PageState,
  pageState,
  parseFieldScan,
  sha256Hex,
  siteRulesFor,
  stateVersion,
  textOf,
} from "../../shared/local/browser-rules.ts";
import { type BrowserLayout, DEFAULT_PARTITION } from "../../shared/local/browser-runtime.ts";
import type { DownloadWrite } from "../../shared/local/download-write.ts";
import type { DeviceAdapter } from "../adapter.ts";
import type { AgentBrowserClient } from "./agent-browser.ts";
import { PngError, redactPng } from "./png-redact.ts";

export interface DownloadSink {
  write(input: DownloadWrite, signal: AbortSignal): Promise<DeviceResult>;
}

export const REFUSING_SINK: DownloadSink = {
  write: async () => ({
    status: "refused",
    code: "outside_allowance",
    detail: "No allowed folder takes downloads on this device yet.",
  }),
};

export interface BrowserFiles {
  read(path: string): Promise<Uint8Array | null>;
  remove(path: string): Promise<void>;
  purge(folder: string): Promise<void>;
  mkdir(folder: string): Promise<void>;
}

export interface ProxyRefusals {
  reset(): void;
  last(): string | null;
}

export interface BrowserAdapterOptions {
  readonly layout: BrowserLayout;
  readonly version: string;
  clientFor(partition: string): AgentBrowserClient;
  setRules(rules: ProxySiteRules): void;
  readonly refusals: ProxyRefusals;
  allowances(): BrowserAllowances;
  readonly sink: DownloadSink;
  readonly files: BrowserFiles;
  teardown(partition: string): Promise<void>;
  onStep?(step: BrowserStep): void;
}

export const BROWSER_KINDS = [
  "browser.open",
  "browser.snapshot",
  "browser.press",
  "browser.fill",
  "browser.wait",
  "browser.extract",
  "browser.screenshot",
  "browser.download",
] as const satisfies readonly DeviceCommandKind[];
type BrowserKind = (typeof BROWSER_KINDS)[number];

const SCHEMAS: Record<BrowserKind, z.ZodType> = {
  "browser.open": BrowserOpenArgsSchema,
  "browser.snapshot": BrowserPageArgsSchema,
  "browser.press": BrowserPressArgsSchema,
  "browser.fill": BrowserFillArgsSchema,
  "browser.wait": BrowserWaitArgsSchema,
  "browser.extract": BrowserExtractArgsSchema,
  "browser.screenshot": BrowserPageArgsSchema,
  "browser.download": BrowserDownloadArgsSchema,
};

interface CommonArgs {
  partition?: string;
  boundary?: DeviceSubBoundary;
}

class StepEnd extends Error {
  constructor(readonly result: DeviceResult) {
    super(result.status);
  }
}

export const NAVIGATION_KEYS: ReadonlySet<string> = new Set(["Tab", "Shift+Tab", "Escape"]);

const MACHINE_CODE = /^[a-z][a-z0-9_]{0,39}$/;

function failed(code: string, detail: string): never {
  throw new StepEnd({
    status: "failed",
    code: MACHINE_CODE.test(code) ? code : "browser_action",
    detail,
  });
}

function refused(code: DeviceRefusal, detail: string): never {
  throw new StepEnd({ status: "refused", code, detail });
}

function selector(ref: string): string {
  return ref.startsWith("@") ? ref : `@${ref}`;
}

function outcomeOf(result: DeviceResult): BrowserStep["outcome"] {
  if (result.status === "confirmation_required") return "refused";
  return result.status;
}

const REFUSAL_DETAIL: Partial<Record<DeviceRefusal, string>> = {
  origin_not_allowed: "This website is not allowed on this device.",
  outside_boundary: "This workflow's approval names no websites.",
  private_address: "This address is on a private network and was not entered on this device.",
  credential_field: "SubKit does not type into password, one-time code or card fields.",
  secure_focus: "A password field is focused, so no screenshot was taken.",
};

function detailFor(code: DeviceRefusal): string {
  return REFUSAL_DETAIL[code] ?? "The browser refused this action.";
}

function asRefusal(code: string | null): DeviceRefusal {
  return code === "private_address" ? "private_address" : "origin_not_allowed";
}

type Handoff = "click" | "key";

const UNCERTAIN_DETAIL: Record<Handoff, string> = {
  click: "The click may have reached the page. SubKit does not repeat it.",
  key: "The key press may have reached the page. SubKit does not repeat it.",
};

function uncertain(handoff: Handoff): DeviceResult {
  return { status: "failed", code: "delivery_uncertain", detail: UNCERTAIN_DETAIL[handoff] };
}

export function createBrowserAdapter(options: BrowserAdapterOptions): DeviceAdapter {
  const run = async (
    command: DeviceCommand,
    kind: BrowserKind,
    args: CommonArgs & Record<string, unknown>,
    signal: AbortSignal,
    page: { state: PageState | null },
    handed: { kind: Handoff | null },
  ): Promise<{ output: Record<string, unknown>; evidence: DeviceEvidence }> => {
    const partition = args.partition ?? DEFAULT_PARTITION;
    const client = options.clientFor(partition);
    const allowances = options.allowances();
    const decided = siteRulesFor(command, args.boundary?.sites, allowances);
    options.setRules(decided ?? CLOSED_RULES);
    if (decided === null) refused("outside_boundary", detailFor("outside_boundary"));
    const rules = decided;
    options.refusals.reset();
    await options.files.purge(options.layout.downloads);

    const call = async (tool: string, input: Record<string, unknown>) => {
      if (signal.aborted) throw new StepEnd({ status: "stopped" });
      const result = await client.call(tool, input, signal);
      if (signal.aborted) throw new StepEnd({ status: "stopped" });
      if (!result.ok) failed(result.code, "The browser action failed.");
      return result.data;
    };

    const hand = async (kind: Handoff, tool: string, input: Record<string, unknown>) => {
      if (signal.aborted) throw new StepEnd({ status: "stopped" });
      handed.kind = kind;
      const result = await client.call(tool, input, signal);
      if (signal.aborted) throw new StepEnd({ status: "stopped" });
      if (!result.ok) {
        if (result.code !== "browser_timeout") handed.kind = null;
        failed(result.code, "The browser action failed.");
      }
      return result.data;
    };

    const readState = async () => {
      const url = textOf(await call("agent_browser_get_url", {}), ["url", "value", "result"]);
      const title = textOf(await call("agent_browser_get_title", {}), ["title", "value", "result"]);
      page.state = pageState(url, title);
      return { url, state: page.state };
    };

    const settle = async () => {
      const { url, state } = await readState();
      const target = url === null ? null : requestTarget(url);
      if (target === null || !targetAllowed(target, rules).ok) {
        const code = asRefusal(options.refusals.last());
        refused(code, detailFor(code));
      }
      return state;
    };

    const evidenceOf = (state: PageState): DeviceEvidence => ({
      after_version: stateVersion(state),
    });

    if (kind === "browser.open") {
      const url = String(args.url);
      const target = /^https?:/i.test(url) ? requestTarget(url) : null;
      if (target === null) refused("origin_not_allowed", detailFor("origin_not_allowed"));
      const allowed = targetAllowed(target, rules);
      if (!allowed.ok) refused(allowed.code, detailFor(allowed.code));
      await call("agent_browser_open", { url: target.url });
      const state = await settle();
      return { output: { origin: state.origin }, evidence: evidenceOf(state) };
    }

    if (kind === "browser.snapshot") {
      const snapshot = await call("agent_browser_snapshot", { interactive: true });
      const { state } = await readState();
      return { output: { snapshot }, evidence: evidenceOf(state) };
    }

    if (kind === "browser.press") {
      const press = args as unknown as BrowserPressArgs;
      if (press.action === "click")
        await hand("click", "agent_browser_click", { selector: selector(press.ref) });
      else if (press.action === "key") {
        if (!NAVIGATION_KEYS.has(press.key)) {
          const scan = parseFieldScan(
            await call("agent_browser_eval", { script: FIELD_SCAN_SCRIPT }),
          );
          if (!scan.ok)
            failed("field_check_unavailable", "The focused field could not be checked.");
          if (scan.secure_focus) refused("credential_field", detailFor("credential_field"));
          await hand("key", "agent_browser_press", { key: press.key });
        } else await call("agent_browser_press", { key: press.key });
      } else
        await call("agent_browser_scroll", { direction: press.direction, amount: press.pixels });
      const state = await settle();
      return { output: { origin: state.origin }, evidence: evidenceOf(state) };
    }

    if (kind === "browser.fill") {
      const fill = args as unknown as BrowserFillArgs;
      const target = selector(fill.ref);
      const attribute = async (name: string) =>
        textOf(await call("agent_browser_get_attr", { selector: target, name }), [
          "value",
          "attr",
          "result",
        ]);
      const field = {
        input_type: await attribute("type"),
        autocomplete: await attribute("autocomplete"),
      };
      if (isCredentialField(field)) refused("credential_field", detailFor("credential_field"));
      if (fill.mode === "select")
        await call("agent_browser_select", { selector: target, values: fill.values });
      else
        await call(fill.mode === "type" ? "agent_browser_type" : "agent_browser_fill", {
          selector: target,
          text: fill.text,
        });
      const { state } = await readState();
      return { output: { origin: state.origin }, evidence: evidenceOf(state) };
    }

    if (kind === "browser.wait") {
      const wait = args as unknown as BrowserWaitArgs;
      if (wait.for === "load") await call("agent_browser_wait_for_load", { state: wait.state });
      else if (wait.for === "text") await call("agent_browser_wait_for_text", { text: wait.text });
      else await call("agent_browser_wait_ms", { ms: wait.ms });
      const state = await settle();
      return { output: { origin: state.origin }, evidence: evidenceOf(state) };
    }

    if (kind === "browser.extract") {
      const extract = args as unknown as BrowserExtractArgs;
      const data = await call("agent_browser_get_text", {
        selector: extract.ref ? selector(extract.ref) : "body",
      });
      const { state } = await readState();
      return {
        output: { text: textOf(data, ["text", "value", "result"]) },
        evidence: evidenceOf(state),
      };
    }

    if (kind === "browser.screenshot") {
      const { state } = await readState();
      const scan = parseFieldScan(await call("agent_browser_eval", { script: FIELD_SCAN_SCRIPT }));
      if (!scan.ok) failed("redaction_unavailable", "The screenshot could not be redacted.");
      if (scan.secure_focus) refused("secure_focus", detailFor("secure_focus"));
      const path = join(options.layout.captures, `${sha256Hex(command.command_id)}.png`);
      await options.files.mkdir(options.layout.captures);
      try {
        await call("agent_browser_screenshot", { path });
        const bytes = await options.files.read(path);
        if (bytes === null) failed("screenshot_missing", "The screenshot was not saved.");
        let image: Buffer;
        try {
          image = redactPng(bytes, scan.rects);
        } catch (error) {
          if (error instanceof PngError)
            failed("redaction_unavailable", "The screenshot could not be redacted.");
          throw error;
        }
        const digest = sha256Hex(image);
        return {
          output: { image: { mime: "image/png", base64: image.toString("base64") } },
          evidence: { ...evidenceOf(state), screenshot_ref: `sha256:${digest}` },
        };
      } finally {
        await options.files.remove(path);
      }
    }

    const download = BrowserDownloadArgsSchema.parse(args);
    const named = downloadAllowed({ name: download.name, size: 1, mime: null });
    if (!named.ok) refused(named.code, "This file name or type cannot be downloaded.");
    const folder = join(options.layout.downloads, sha256Hex(command.command_id).slice(0, 16));
    const path = join(folder, download.name);
    await options.files.mkdir(folder);
    try {
      await call("agent_browser_download", { selector: selector(download.ref), path });
      const bytes = await options.files.read(path);
      if (bytes === null) failed("download_missing", "The download did not arrive.");
      const checked = downloadAllowed({ name: download.name, size: bytes.length, mime: null });
      if (!checked.ok) refused(checked.code, "This file cannot be downloaded.");
      const { state } = await readState();
      const written = await options.sink.write(
        { command, folder_id: download.folder_id, name: download.name, bytes },
        signal,
      );
      if (written.status !== "done") throw new StepEnd(written);
      return {
        output: { file: written.output, bytes: bytes.length },
        evidence: { ...written.evidence, ...evidenceOf(state) },
      };
    } finally {
      await options.files.purge(options.layout.downloads);
    }
  };

  return {
    name: "agent-browser",
    version: options.version,
    kinds: BROWSER_KINDS,
    async execute(command, signal) {
      const kind = command.kind as BrowserKind;
      const parsed = SCHEMAS[kind].safeParse(command.args);
      const page: { state: PageState | null } = { state: null };
      const handed: { kind: Handoff | null } = { kind: null };
      let result: DeviceResult;
      let stopping: Promise<void> | null = null;
      const args = parsed.success ? (parsed.data as CommonArgs & Record<string, unknown>) : {};
      const partition = args.partition ?? DEFAULT_PARTITION;
      const onAbort = () => {
        stopping = options.teardown(partition);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (!parsed.success) failed("invalid_args", "The browser command is not valid.");
        const done = await run(command, kind, args, signal, page, handed);
        result = { status: "done", output: done.output, evidence: done.evidence };
      } catch (error) {
        if (signal.aborted) result = { status: "stopped" };
        else if (error instanceof StepEnd) result = error.result;
        else
          result = {
            status: "failed",
            code: "browser_action",
            detail: "The browser action failed.",
          };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      if (signal.aborted) {
        if (stopping === null) stopping = options.teardown(partition);
        await stopping;
        result = { status: "stopped" };
      }
      if (handed.kind !== null && result.status !== "done") result = uncertain(handed.kind);
      const step: BrowserStep = {
        action: kind,
        origin: page.state?.origin ?? null,
        title_sha256: page.state?.title_sha256 ?? null,
        outcome: outcomeOf(result),
        ...(result.status === "refused" || result.status === "failed" ? { code: result.code } : {}),
      };
      options.onStep?.(step);
      if (result.status === "done")
        return { ...result, output: { ...(result.output as Record<string, unknown>), step } };
      return result;
    },
  };
}
