import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { IconButton } from "@/components/cockpit/icon-button";
import {
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldLabel,
  FormDialog,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@/components/cockpit/patterns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  type AppView,
  appBearerProvider,
  type ClaimDraft,
  type ClaimType,
  PROVIDERS_PATH,
  SIGN_IN_ALGORITHMS,
  type SignInDraft,
  signInDraft,
  signInErrors,
  signInProvider,
  withProvider,
} from "@/pages/apps-model";
import { dialogError, settingValue, useAppSettingsSave, useSettingsSnapshot } from "./apps-data";

export function AppSignInDialog({
  app,
  open,
  onOpenChange,
}: {
  app: AppView;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const settings = useSettingsSnapshot(open);
  const save = useAppSettingsSave();
  const providers = settingValue(settings.data, PROVIDERS_PATH);
  const provider = appBearerProvider(providers, app.id);
  const [draft, setDraft] = useState<SignInDraft>(() => signInDraft(provider, app.id));
  const [tried, setTried] = useState(false);
  const loaded = Boolean(settings.data);
  useEffect(() => {
    if (!open) return;
    setDraft(signInDraft(provider, app.id));
    setTried(false);
    save.reset();
  }, [open, loaded, app.id]);
  const errors = signInErrors(
    app.id,
    draft,
    providers,
    typeof provider?.id === "string" ? provider.id : null,
  );
  const set = (patch: Partial<SignInDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const setClaim = (index: number, patch: Partial<ClaimDraft>) =>
    set({
      required_claims: draft.required_claims.map((claim, position) =>
        position === index ? { ...claim, ...patch } : claim,
      ),
    });
  const text = (key: SignInTextField, label: string, testId: string) => (
    <Field>
      <FieldLabel htmlFor={testId}>{label}</FieldLabel>
      <Input
        id={testId}
        value={draft[key]}
        onChange={(event) => set({ [key]: event.target.value })}
        data-testid={testId}
      />
    </Field>
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title={t(provider ? "apps.action.editSignIn" : "apps.action.addSignIn")}
      description={t("apps.dialog.description")}
      submit={{
        label: t("common.save"),
        pending: save.isPending,
        disabled: !loaded,
        testId: "apps-sign-in-submit",
      }}
      error={dialogError(tried, errors, save.error, t)}
      failure={tried && errors.length > 0 ? undefined : save.error}
      onSubmit={() => {
        setTried(true);
        if (errors.length > 0) return;
        save.mutate(
          {
            [PROVIDERS_PATH]: (value) => {
              const current = appBearerProvider(value, app.id);
              const id = typeof current?.id === "string" ? current.id : null;
              return withProvider(value, id, signInProvider(current, draft, app.id));
            },
          },
          {
            onSuccess: (outcome) => {
              onOpenChange(false);
              toast.success(
                t(outcome === "active" ? "apps.save.signInDone" : "apps.save.restartRequired"),
              );
            },
          },
        );
      }}
      testId="apps-sign-in-dialog"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {text("id", t("apps.field.signInId"), "apps-sign-in-id")}
        {text("label", t("apps.field.signInLabel"), "apps-sign-in-label")}
      </div>
      {text("issuer_url", t("apps.field.issuer"), "apps-sign-in-issuer")}
      {text("jwks_uri", t("apps.field.jwks"), "apps-sign-in-jwks")}
      <div className="grid gap-3 sm:grid-cols-2">
        {text("audience", t("apps.field.audience"), "apps-sign-in-audience")}
        {text("tenant_slug", t("apps.field.tenant"), "apps-sign-in-tenant")}
      </div>
      <Field>
        <FieldLabel>{t("apps.field.algorithms")}</FieldLabel>
        <div
          className="grid grid-cols-2 gap-x-3 sm:grid-cols-4"
          data-testid="apps-sign-in-algorithms"
        >
          {SIGN_IN_ALGORITHMS.map((algorithm) => (
            <label
              key={algorithm}
              className="flex min-h-10 items-center gap-3 text-sm"
              htmlFor={`apps-sign-in-algorithm-${algorithm}`}
            >
              <Checkbox
                id={`apps-sign-in-algorithm-${algorithm}`}
                checked={draft.algorithms.includes(algorithm)}
                onCheckedChange={(value) =>
                  set({
                    algorithms:
                      value === true
                        ? [...draft.algorithms, algorithm]
                        : draft.algorithms.filter((item) => item !== algorithm),
                  })
                }
                data-testid={`apps-sign-in-algorithm-${algorithm}`}
              />
              {algorithm}
            </label>
          ))}
        </div>
      </Field>
      <label className="flex min-h-10 items-center gap-3 text-sm" htmlFor="apps-sign-in-anonymous">
        <Switch
          id="apps-sign-in-anonymous"
          checked={draft.reject_anonymous}
          onCheckedChange={(checked) => set({ reject_anonymous: checked })}
          data-testid="apps-sign-in-anonymous"
        />
        {t("apps.field.anonymous")}:{" "}
        {t(draft.reject_anonymous ? "apps.anonymous.rejected" : "apps.anonymous.allowed")}
      </label>
      <Field>
        <FieldLabel>{t("apps.field.claims")}</FieldLabel>
        <div className="flex flex-col gap-2" data-testid="apps-sign-in-claims">
          {draft.required_claims.length === 0 ? (
            <FieldDescription>{t("apps.claims.none")}</FieldDescription>
          ) : null}
          {draft.required_claims.map((claim, index) => (
            <div
              key={index}
              className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_auto]"
              data-testid={`apps-sign-in-claim-${index}`}
            >
              <Input
                value={claim.path}
                aria-label={t("apps.field.claimPath")}
                placeholder={t("apps.field.claimPath")}
                onChange={(event) => setClaim(index, { path: event.target.value })}
                data-testid={`apps-sign-in-claim-${index}-path`}
              />
              <Select
                value={claim.type}
                onValueChange={(value) =>
                  setClaim(index, {
                    type: value as ClaimType,
                    value:
                      value === "boolean" ? "true" : claim.type === "boolean" ? "" : claim.value,
                  })
                }
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={t("apps.field.claimType")}
                  data-testid={`apps-sign-in-claim-${index}-type`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {CLAIM_TYPES.map((type) => (
                      <SelectItem
                        key={type}
                        value={type}
                        data-testid={`apps-sign-in-claim-${index}-type-${type}`}
                      >
                        {t(CLAIM_TYPE_LABEL[type])}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {claim.type === "boolean" ? (
                <Select value={claim.value} onValueChange={(value) => setClaim(index, { value })}>
                  <SelectTrigger
                    className="w-full"
                    aria-label={t("apps.field.claimValue")}
                    data-testid={`apps-sign-in-claim-${index}-value`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="true" data-testid={`apps-sign-in-claim-${index}-true`}>
                        true
                      </SelectItem>
                      <SelectItem value="false" data-testid={`apps-sign-in-claim-${index}-false`}>
                        false
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={claim.value}
                  inputMode={claim.type === "number" ? "decimal" : undefined}
                  aria-label={t("apps.field.claimValue")}
                  placeholder={t("apps.field.claimValue")}
                  onChange={(event) => setClaim(index, { value: event.target.value })}
                  data-testid={`apps-sign-in-claim-${index}-value`}
                />
              )}
              <IconButton
                type="button"
                label={t("apps.claim.remove")}
                onClick={() =>
                  set({
                    required_claims: draft.required_claims.filter(
                      (_, position) => position !== index,
                    ),
                  })
                }
                data-testid={`apps-sign-in-claim-${index}-remove`}
              >
                <Trash2 />
              </IconButton>
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                set({
                  required_claims: [
                    ...draft.required_claims,
                    { path: "", type: "string", value: "" },
                  ],
                })
              }
              data-testid="apps-sign-in-claim-add"
            >
              <Plus aria-hidden="true" />
              {t("apps.claim.add")}
            </Button>
          </div>
        </div>
      </Field>
    </FormDialog>
  );
}

type SignInTextField = "id" | "label" | "issuer_url" | "jwks_uri" | "audience" | "tenant_slug";

const CLAIM_TYPES: readonly ClaimType[] = ["string", "boolean", "number"];

const CLAIM_TYPE_LABEL: Readonly<Record<ClaimType, TranslationKey>> = {
  string: "apps.claimType.string",
  boolean: "apps.claimType.boolean",
  number: "apps.claimType.number",
};
