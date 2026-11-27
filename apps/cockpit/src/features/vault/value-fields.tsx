import { Info } from "lucide-react";
import { useEffect, useState } from "react";
import { TextAreaField, TextField } from "@/components/cockpit/form-field";
import {
  brandName,
  detectedBrand,
  ENTRY_FIELDS,
  type EntryField,
  type EntryKind,
  isRequired,
  type Problem,
  parseTotp,
} from "@/features/vault/model/entries";
import { totpPreview, totpSecondsLeft } from "@/features/vault/model/totp";
import type { ValueDraft } from "@/features/vault/model/vault";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

const LABELS: Readonly<Record<EntryField, TranslationKey>> = {
  totp: "vault.field.totp",
  origins: "vault.field.origins",
  number: "vault.field.number",
  expiry: "vault.field.expiry",
  holder: "vault.field.holder",
  iban: "vault.field.iban",
  bic: "vault.field.bic",
  full_name: "vault.field.full_name",
  birth_date: "vault.field.birth_date",
  document_type: "vault.field.document_type",
  document_number: "vault.field.document_number",
  nationality: "vault.field.nationality",
  name: "vault.field.addressName",
  line1: "vault.field.line1",
  line2: "vault.field.line2",
  postal_code: "vault.field.postal_code",
  city: "vault.field.city",
  region: "vault.field.region",
  country: "vault.field.country",
  phone: "vault.field.phone",
  email: "vault.field.email",
  text: "vault.field.text",
};

const HELP: Readonly<Partial<Record<EntryField, TranslationKey>>> = {
  totp: "vault.field.totpHelp",
  origins: "vault.field.originsHelp",
  number: "vault.field.numberHelp",
  expiry: "vault.field.expiryHelp",
  country: "vault.field.countryHelp",
};

const INPUT_MODE: Readonly<Partial<Record<EntryField, "numeric" | "email" | "tel">>> = {
  number: "numeric",
  expiry: "numeric",
  phone: "tel",
  email: "email",
};

const MONO: ReadonlySet<EntryField> = new Set(["totp", "number", "expiry", "iban", "bic"]);

export type FieldErrors = Partial<Record<string, Problem>>;

export function TotpPreview({ idPrefix, raw }: { idPrefix: string; raw: string }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const [code, setCode] = useState<string | null>(null);
  const valid = parseTotp(raw) !== null;
  useEffect(() => {
    if (!valid) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [valid]);
  const window30 = Math.floor(now / 30_000);
  useEffect(() => {
    let live = true;
    if (!valid) {
      setCode(null);
      return;
    }
    totpPreview(raw, window30 * 30_000)
      .then((next) => {
        if (live) setCode(next);
      })
      .catch(() => {
        if (live) setCode(null);
      });
    return () => {
      live = false;
    };
  }, [raw, valid, window30]);
  if (!valid || !code) return null;
  return (
    <div
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border px-3 py-2"
      data-testid={`${idPrefix}-totp-preview`}
      id={`${idPrefix}-totp-preview`}
    >
      <span className="text-xs text-muted-foreground">{t("vault.totp.preview")}</span>
      <output className="font-mono text-base tabular-nums tracking-widest" aria-live="polite">
        {code.slice(0, 3)} {code.slice(3)}
      </output>
      <span className="text-xs text-muted-foreground tabular-nums">
        {t("vault.totp.renews", { seconds: totpSecondsLeft(raw, now) })}
      </span>
      <span className="basis-full text-xs text-muted-foreground">
        {t("vault.totp.previewNote")}
      </span>
    </div>
  );
}

function NoCvvNote({ idPrefix }: { idPrefix: string }) {
  const { t } = useI18n();
  return (
    <p
      id={`${idPrefix}-no-cvv`}
      className="flex gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground"
      data-testid={`${idPrefix}-no-cvv`}
    >
      <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      {t("vault.card.noCvv")}
    </p>
  );
}

function EntryInput({
  idPrefix,
  kind,
  field,
  value,
  error,
  describedBy,
  onChange,
}: {
  idPrefix: string;
  kind: EntryKind;
  field: EntryField;
  value: string;
  error: string | null;
  describedBy?: string;
  onChange(value: string): void;
}) {
  const { t } = useI18n();
  const id = `${idPrefix}-${field}`;
  const base = t(LABELS[field]);
  const required = isRequired(kind, field);
  const label = required || field === "origins" ? base : t("vault.field.optional", { label: base });
  const help = HELP[field] ? t(HELP[field]) : undefined;
  if (field === "text" || field === "origins")
    return (
      <TextAreaField
        id={id}
        label={label}
        help={help}
        value={value}
        onChange={onChange}
        error={error}
        rows={field === "text" ? 6 : 3}
        required={required}
        mono={field === "origins"}
      />
    );
  return (
    <TextField
      id={id}
      label={label}
      help={help}
      value={value}
      onChange={onChange}
      error={error}
      required={required}
      mono={MONO.has(field)}
      type={field === "birth_date" ? "date" : field === "email" ? "email" : "text"}
      placeholder={field === "expiry" ? "MM/YY" : undefined}
      {...(INPUT_MODE[field] ? { inputMode: INPUT_MODE[field] } : {})}
      {...(describedBy ? { describedBy } : {})}
    />
  );
}

export function ValueFields({
  idPrefix,
  draft,
  onChange,
  error,
  fieldErrors = {},
}: {
  idPrefix: string;
  draft: ValueDraft;
  onChange(change: Partial<ValueDraft>): void;
  error: string | null;
  fieldErrors?: FieldErrors;
}) {
  const { t } = useI18n();
  const fields = draft.fields ?? {};
  const setField = (field: EntryField, value: string) =>
    onChange({ fields: { ...fields, [field]: value } });
  const message = (field: EntryField) => {
    const problem = fieldErrors[field];
    return problem ? t(problem.key, problem.values) : null;
  };
  const input = (field: EntryField, describedBy?: string) => (
    <EntryInput
      key={field}
      idPrefix={idPrefix}
      kind={draft.kind}
      field={field}
      value={fields[field] ?? ""}
      error={message(field)}
      onChange={(value) => setField(field, value)}
      {...(describedBy ? { describedBy } : {})}
    />
  );
  if (draft.kind === "secret")
    return (
      <TextAreaField
        id={`${idPrefix}-token`}
        label={t("vault.field.token")}
        help={t("vault.field.tokenHelp")}
        value={draft.token}
        onChange={(token) => onChange({ token })}
        error={error}
        rows={4}
        required
        masked
        mono
      />
    );
  if (draft.kind === "login")
    return (
      <>
        <TextField
          id={`${idPrefix}-username`}
          label={t("vault.field.username")}
          value={draft.username}
          onChange={(username) => onChange({ username })}
          required
        />
        <TextField
          id={`${idPrefix}-password`}
          label={t("vault.field.password")}
          type="password"
          value={draft.password}
          onChange={(password) => onChange({ password })}
          error={error}
          required
        />
        {input("totp", `${idPrefix}-totp-preview`)}
        <TotpPreview idPrefix={idPrefix} raw={fields.totp ?? ""} />
        {input("origins")}
      </>
    );
  if (draft.kind === "card") {
    const brand = brandName(detectedBrand(fields.number ?? ""));
    const brandId = `${idPrefix}-number-brand`;
    return (
      <>
        {input("number", brand ? `${brandId} ${idPrefix}-no-cvv` : `${idPrefix}-no-cvv`)}
        {brand ? (
          <p id={brandId} className="-mt-2 text-xs text-muted-foreground" data-testid={brandId}>
            {t("vault.card.brandDetected", { brand })}
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {input("expiry")}
          {input("holder")}
        </div>
        <NoCvvNote idPrefix={idPrefix} />
      </>
    );
  }
  return <>{ENTRY_FIELDS[draft.kind].map((field) => input(field))}</>;
}
