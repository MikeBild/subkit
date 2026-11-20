import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { useSession } from "@/app/session";
import {
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  FormDialog,
  Input,
} from "@/components/cockpit/patterns";
import { useCurrentVersionDag } from "@/components/cockpit/workflow-versions";
import { useI18n } from "@/lib/i18n-context";
import {
  type AppView,
  definitionGuardBucket,
  EXECUTION_ENVIRONMENTS,
  PRODUCTS_PATH,
  type ProductDraft,
  productDraft,
  productEntry,
  productErrors,
  productsFrom,
  withProduct,
} from "@/pages/apps-model";
import {
  dialogError,
  environmentLabel,
  settingValue,
  useAppSettingsSave,
  useSettingsSnapshot,
} from "./apps-data";
import { ChoiceField } from "./parts";

export function AppSettingsDialog({
  app,
  open,
  onOpenChange,
}: {
  app: AppView;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const settings = useSettingsSnapshot(open);
  const workflows = useQuery({
    queryKey: ["admin", "workflows"],
    enabled: open && session.permissions.includes("workflow:read"),
    queryFn: () => apiCall("get", "/v1/workflows", { query: { limit: 200 } }),
  });
  const save = useAppSettingsSave();
  const entry = productsFrom(settingValue(settings.data, PRODUCTS_PATH))[app.id] ?? null;
  const [draft, setDraft] = useState<ProductDraft>(() => productDraft(entry, app));
  const [tried, setTried] = useState(false);
  const loaded = Boolean(settings.data);
  useEffect(() => {
    if (!open) return;
    setDraft(productDraft(entry, app));
    setTried(false);
    save.reset();
  }, [open, loaded, app.id]);
  const items = workflows.data?.items ?? [];
  const picked = items.find((item) => item.id === draft.assistant_workflow_id) ?? null;
  const currentDag = useCurrentVersionDag(
    draft.assistant_workflow_id,
    picked?.current_version_id,
    picked?.current_version,
    open && picked !== null && draft.assistant_workflow_id !== app.settings?.assistant_workflow.id,
  );
  const suggestion =
    draft.assistant_workflow_id === app.settings?.assistant_workflow.id
      ? (app.settings?.daily_limit?.bucket ?? null)
      : definitionGuardBucket(currentDag.data);
  useEffect(() => {
    if (suggestion && !draft.budget_bucket.trim())
      setDraft((current) => ({ ...current, budget_bucket: suggestion }));
  }, [suggestion]);
  const options = [
    ...items.map((item) => ({ value: item.id, label: item.name || item.slug || item.id })),
    ...(draft.assistant_workflow_id && !picked
      ? [
          {
            value: draft.assistant_workflow_id,
            label:
              app.settings?.assistant_workflow.name ??
              app.settings?.assistant_workflow.slug ??
              draft.assistant_workflow_id,
          },
        ]
      : []),
  ];
  const errors = productErrors(app.id, draft);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(app.configured ? "apps.action.editSettings" : "apps.action.configure")}
      description={t("apps.dialog.description")}
      submit={{
        label: t("common.save"),
        pending: save.isPending,
        disabled: !loaded,
        testId: "apps-settings-submit",
      }}
      error={dialogError(tried, errors, save.error, t)}
      failure={tried && errors.length > 0 ? undefined : save.error}
      onSubmit={() => {
        setTried(true);
        if (errors.length > 0) return;
        save.mutate(
          {
            [PRODUCTS_PATH]: (value) =>
              withProduct(value, app.id, productEntry(productsFrom(value)[app.id] ?? null, draft)),
          },
          {
            onSuccess: (outcome) => {
              onOpenChange(false);
              toast.success(
                t(outcome === "active" ? "apps.save.done" : "apps.save.restartRequired"),
              );
            },
          },
        );
      }}
      testId="apps-settings-dialog"
    >
      <ChoiceField
        label={t("apps.field.environment")}
        value={draft.execution_environment}
        onChange={(value) =>
          setDraft((current) => ({
            ...current,
            execution_environment: value === "prod" ? "prod" : "dev",
          }))
        }
        options={EXECUTION_ENVIRONMENTS.map((value) => ({
          value,
          label: environmentLabel(value, t),
        }))}
        testId="apps-settings-environment"
      />
      <ChoiceField
        label={t("apps.field.assistant")}
        help={t("apps.field.assistantHelp")}
        value={draft.assistant_workflow_id}
        onChange={(value) => setDraft((current) => ({ ...current, assistant_workflow_id: value }))}
        placeholder={t("apps.chooseWorkflow")}
        options={options}
        testId="apps-settings-assistant"
        byIndex
      />
      <Field>
        <FieldLabel htmlFor="apps-settings-bucket">{t("apps.field.bucket")}</FieldLabel>
        <Input
          id="apps-settings-bucket"
          value={draft.budget_bucket}
          maxLength={64}
          onChange={(event) =>
            setDraft((current) => ({ ...current, budget_bucket: event.target.value }))
          }
          data-testid="apps-settings-bucket"
        />
        {suggestion && suggestion !== draft.budget_bucket.trim() ? (
          <FieldDescription className="flex flex-wrap items-center gap-2">
            {t("apps.field.bucketSuggested", { bucket: suggestion })}
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setDraft((current) => ({ ...current, budget_bucket: suggestion }))}
              data-testid="apps-settings-bucket-suggestion"
            >
              {t("apps.field.bucketUse")}
            </Button>
          </FieldDescription>
        ) : null}
      </Field>
    </FormDialog>
  );
}
