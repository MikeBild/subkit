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

export const VAULT_USE_KINDS = ["password", "totp"] as const;
export const SecretTicketIdSchema = z.string().uuid();
export const BrowserOriginSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^https?:\/\/[^/?#\s]+$/);

export const BrowserSignInFieldsSchema = z
  .object({
    username: BrowserRefSchema.optional(),
    password: BrowserRefSchema.optional(),
    code: BrowserRefSchema.optional(),
    submit: BrowserRefSchema.optional(),
  })
  .strict()
  .refine((fields) => Object.values(fields).some((ref) => ref !== undefined), {
    message: "name at least one field",
  });

export const BrowserSignInArgsSchema = z
  .object({
    ...common,
    snapshot_id: z.string().min(1).max(200).optional(),
    origin: BrowserOriginSchema,
    fields: BrowserSignInFieldsSchema,
    secret_ticket: SecretTicketIdSchema,
    kind: z.enum(VAULT_USE_KINDS),
  })
  .strict();
export type BrowserSignInArgs = z.infer<typeof BrowserSignInArgsSchema>;

export const PAY_FIELD_NAMES = [
  "number",
  "exp",
  "exp_month",
  "exp_year",
  "holder",
  "cvv",
  "submit",
] as const;
export type PayFieldName = (typeof PAY_FIELD_NAMES)[number];

export const BrowserPayFieldsSchema = z
  .object({
    number: BrowserRefSchema,
    exp: BrowserRefSchema.optional(),
    exp_month: BrowserRefSchema.optional(),
    exp_year: BrowserRefSchema.optional(),
    holder: BrowserRefSchema.optional(),
    cvv: BrowserRefSchema.optional(),
    submit: BrowserRefSchema,
  })
  .strict();

export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
export const AmountMinorSchema = z.number().int().min(1).max(100_000_000);
export const PageFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const BrowserPayArgsSchema = z
  .object({
    ...common,
    snapshot_id: z.string().min(1).max(200).optional(),
    origin: BrowserOriginSchema,
    page_fingerprint: PageFingerprintSchema,
    fields: BrowserPayFieldsSchema,
    field_frames: z.partialRecord(z.enum(PAY_FIELD_NAMES), BrowserOriginSchema),
    secret_ticket: SecretTicketIdSchema,
    amount_minor: AmountMinorSchema,
    currency: CurrencySchema,
  })
  .strict();
export type BrowserPayArgs = z.infer<typeof BrowserPayArgsSchema>;

export const VAULT_FILL_OUTCOMES = ["submitted", "uncertain", "refused"] as const;
export type VaultFillOutcome = (typeof VAULT_FILL_OUTCOMES)[number];

export const BrowserVaultResultSchema = z
  .object({
    filled: z.boolean(),
    submitted: z.boolean(),
    outcome: z.enum(VAULT_FILL_OUTCOMES),
    reason: z.string().max(500).optional(),
    snapshot: z.unknown().optional(),
    step: BrowserStepSchema.optional(),
  })
  .strict();
export type BrowserVaultResult = z.infer<typeof BrowserVaultResultSchema>;

export const SIGN_IN_TICKET_KEYS = ["username", "password", "totp_seed"] as const;
export const PAY_TICKET_KEYS = ["number", "exp_month", "exp_year", "holder", "cvv"] as const;

export const SecretTicketClaimSchema = z
  .object({
    values: z.record(z.string(), z.string()),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type SecretTicketClaim = z.infer<typeof SecretTicketClaimSchema>;

export interface PayFieldFacts {
  readonly role: string | null;
  readonly name: string | null;
}

export function payPageFingerprintText(
  origin: string,
  fields: Readonly<Partial<Record<PayFieldName, PayFieldFacts>>>,
): string {
  const entries = PAY_FIELD_NAMES.flatMap((field) => {
    const facts = fields[field];
    return facts ? [[field, facts.role ?? "", facts.name ?? ""]] : [];
  });
  return JSON.stringify(["pay-page:v1", origin, entries]);
}
