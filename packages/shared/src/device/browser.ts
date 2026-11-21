import { z } from "zod";
import { DeviceSubBoundarySchema } from "./boundary.ts";

export const BrowserPartitionSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const BrowserRefSchema = z.string().regex(/^@?e[0-9]{1,6}$/);

const common = {
  partition: BrowserPartitionSchema.optional(),
  boundary: DeviceSubBoundarySchema.optional(),
};

export const BrowserOpenArgsSchema = z
  .object({ ...common, url: z.string().min(1).max(4096) })
  .strict();
export type BrowserOpenArgs = z.infer<typeof BrowserOpenArgsSchema>;

export const BrowserPageArgsSchema = z.object(common).strict();

export const HANDOVER_REASON_MAX = 200;
export const HandoverReasonSchema = z.string().min(1).max(HANDOVER_REASON_MAX);
export const BrowserHandoverArgsSchema = z
  .object({ ...common, reason: HandoverReasonSchema })
  .strict();
export type BrowserPageArgs = z.infer<typeof BrowserPageArgsSchema>;

export const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;

export const BrowserPressArgsSchema = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("click"), ref: BrowserRefSchema }).strict(),
  z
    .object({
      ...common,
      action: z.literal("key"),
      key: z.string().regex(/^[A-Za-z0-9+]{1,32}$/),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("scroll"),
      direction: z.enum(SCROLL_DIRECTIONS),
      pixels: z.number().int().min(1).max(10_000).default(600),
    })
    .strict(),
]);
export type BrowserPressArgs = z.infer<typeof BrowserPressArgsSchema>;

export const BROWSER_TEXT_MAX = 10_000;

export const BrowserFillArgsSchema = z.discriminatedUnion("mode", [
  z
    .object({
      ...common,
      mode: z.enum(["fill", "type"]),
      ref: BrowserRefSchema,
      text: z.string().max(BROWSER_TEXT_MAX),
    })
    .strict(),
  z
    .object({
      ...common,
      mode: z.literal("select"),
      ref: BrowserRefSchema,
      values: z.array(z.string().max(1000)).min(1).max(50),
    })
    .strict(),
]);
export type BrowserFillArgs = z.infer<typeof BrowserFillArgsSchema>;

export const BROWSER_WAIT_MAX_MS = 30_000;

export const BrowserWaitArgsSchema = z.discriminatedUnion("for", [
  z
    .object({
      ...common,
      for: z.literal("load"),
      state: z.enum(["load", "domcontentloaded", "networkidle"]).default("load"),
    })
    .strict(),
  z.object({ ...common, for: z.literal("text"), text: z.string().min(1).max(1000) }).strict(),
  z
    .object({
      ...common,
      for: z.literal("ms"),
      ms: z.number().int().min(1).max(BROWSER_WAIT_MAX_MS),
    })
    .strict(),
]);
export type BrowserWaitArgs = z.infer<typeof BrowserWaitArgsSchema>;

export const BrowserExtractArgsSchema = z
  .object({ ...common, ref: BrowserRefSchema.optional() })
  .strict();
export type BrowserExtractArgs = z.infer<typeof BrowserExtractArgsSchema>;

export const BrowserDownloadArgsSchema = z
  .object({
    ...common,
    ref: BrowserRefSchema,
    folder_id: z.string().min(1).max(200),
    name: z.string().min(1).max(255),
  })
  .strict();
export type BrowserDownloadArgs = z.infer<typeof BrowserDownloadArgsSchema>;

export const BROWSER_STEP_OUTCOMES = ["done", "refused", "stopped", "failed"] as const;
export type BrowserStepOutcome = (typeof BROWSER_STEP_OUTCOMES)[number];

export const BrowserStepSchema = z
  .object({
    action: z.string().min(1),
    origin: z.string().nullable(),
    title_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    outcome: z.enum(BROWSER_STEP_OUTCOMES),
    code: z.string().optional(),
  })
  .strict();
export type BrowserStep = z.infer<typeof BrowserStepSchema>;
