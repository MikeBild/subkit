import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useReducer } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError, apiRequest } from "@/api/client";
import { useSession } from "@/app/session";
import { SelectField, TextAreaField, TextField } from "@/components/cockpit/form-field";
import {
  Button,
  ConfirmDialog,
  type DialogError,
  dialogFailure,
  FormDialog,
} from "@/components/cockpit/patterns";
import {
  categoryChoices,
  metadataPatch,
  normalizeCategoryInput,
  recordCategory,
  recordDescription,
  writtenByAssistant,
} from "@/features/catalog";
import { connectorSignIn, signInFailure } from "@/features/connectors/api/connector-sign-in";
import { authLabel } from "@/features/connectors/model/connector-labels";
import { humanizeCategory } from "@/features/workflows/model";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { offersKeyReplacement } from "../model/connector-detail-model";
import {
  type ConnectorWizard,
  type ConnectorWizardEvent,
  connectorWizardReducer,
  type FieldValue,
} from "../model/connector-wizard";
import {
  type ConnectorEditDraft,
  type ConnectorEditPrior,
  type ConnectorSignIn,
  connectorEditPlan,
  connectorEditProblem,
  connectorTargetOf,
  missingHeaderValues,
  type OAuthClientFields,
  oauthClientOf,
  replacesEveryHeader,
  signedJwtFieldsOf,
  signInOf,
} from "../model/create-connector-model";
import { ConnectorSignInFields } from "./connector-sign-in-fields";

const NEW_CATEGORY = "__new__";

type RecordValue = Record<string, unknown>;

const text = (record: RecordValue, key: string): string =>
  typeof record[key] === "string" ? (record[key] as string) : "";

interface EditFields {
  name: string;
  address: string;
  signIn: ConnectorSignIn | null;
  secret: string;
  oauth: OAuthClientFields;
  signedJwt: ReturnType<typeof signedJwtFieldsOf>;
  typedHeader: string | null;
  headerValues: Record<string, string>;
  missingHeaders: readonly string[];
  description: string;
  choice: string;
  fresh: string;
}
type EditWizard = ConnectorWizard<EditFields, "edit", DialogError>;
type EditEvent = ConnectorWizardEvent<EditFields, "edit", DialogError>;
const editWizardReducer = (state: EditWizard, event: EditEvent) =>
  connectorWizardReducer(state, event);

export function ConnectorEditDialog({
  open,
  onOpenChange,
  id,
  record,
  headerNames,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  id: string;
  record: RecordValue;
  headerNames: readonly string[];
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const callbackUrl = useSession().oauth_callback_url;
  const prior: ConnectorEditPrior = {
    driver: text(record, "driver") || null,
    authType: text(record, "auth_type") || null,
    name: text(record, "display_name") || text(record, "name"),
    address: text(record, "base_url"),
    config: record.config,
    headerNames,
  };
  const target = connectorTargetOf(prior.driver);
  const priorSignIn = signInOf(prior.authType);
  const [wizard, dispatch] = useReducer(
    editWizardReducer,
    null,
    (): EditWizard => ({
      step: "edit",
      error: null,
      fields: {
        name: prior.name,
        address: prior.address,
        signIn: priorSignIn,
        secret: "",
        oauth: oauthClientOf(prior.config),
        signedJwt: signedJwtFieldsOf(prior.config),
        typedHeader: null,
        headerValues: {},
        missingHeaders: [],
        description: recordDescription(record),
        choice: recordCategory(record),
        fresh: "",
      },
    }),
  );
  const { error } = wizard;
  const {
    name,
    address,
    signIn,
    secret,
    oauth,
    signedJwt,
    typedHeader,
    headerValues,
    missingHeaders,
    description,
    choice,
    fresh,
  } = wizard.fields;
  const edit = <K extends keyof EditFields>(key: K, value: FieldValue<EditFields, K>) =>
    dispatch({ type: "edit", key, value } as EditEvent);
  const set =
    <K extends keyof EditFields>(key: K) =>
    (value: EditFields[K]) =>
      edit(key, value);
  const fail = (problem: DialogError) => dispatch({ type: "fail", error: problem });
  const header = typedHeader ?? headerNames[0] ?? "";
  const everyHeader = replacesEveryHeader(prior);
  useEffect(() => {
    if (!open) return;
    edit("description", recordDescription(record));
    edit("choice", recordCategory(record));
    edit("fresh", "");
  }, [open, record]);
  const vocabulary = useQuery({
    queryKey: ["catalog-categories"],
    enabled: open,
    queryFn: () => apiCall("get", "/v1/categories", {}),
  });
  const choices = categoryChoices(
    (vocabulary.data?.categories ?? []).map((entry) => entry.category),
    recordCategory(record),
  );
  const freshCategory = choice === NEW_CATEGORY ? normalizeCategoryInput(fresh) : null;
  const category = choice === NEW_CATEGORY ? (freshCategory ?? "") : choice;
  const accept = useMutation({
    mutationFn: () =>
      apiCall("patch", "/v1/connectors/{id}", {
        path: { id },
        body: { description: recordDescription(record), accept_description: true },
      }),
    onSuccess: async () => {
      toast.success(t("catalogMeta.saved"));
      await client.invalidateQueries({ queryKey: ["catalog-detail", "connectors", id] });
      await client.invalidateQueries({ queryKey: ["catalog"] });
    },
    onError: (failure) => reportFailure(t("detail.saveFailed"), failure),
  });
  const draft: ConnectorEditDraft = {
    name,
    address,
    signIn,
    secret,
    header,
    headerValues,
    oauth,
    signedJwt,
  };
  const unchangedKind = signIn === priorSignIn;
  const save = useMutation({
    mutationFn: async () => {
      const plan = connectorEditPlan(prior, draft);
      const metadata = category ? metadataPatch(record, { description, category }) : null;
      const connector = await apiCall("patch", "/v1/connectors/{id}", {
        path: { id },
        body: { ...plan.patch, ...metadata },
      });
      if (plan.credential)
        await apiCall("post", "/v1/connectors/{id}/credentials", {
          path: { id },
          body: plan.credential,
        });
      return {
        replaced: Boolean(plan.credential),
        route: plan.startSignIn ? connectorSignIn(connector) : null,
      };
    },
    onSuccess: async ({ replaced, route }) => {
      edit("secret", "");
      edit("headerValues", {});
      await client.invalidateQueries({ queryKey: ["catalog-detail", "connectors", id] });
      await client.invalidateQueries({ queryKey: ["connector-credential", id] });
      await client.invalidateQueries({ queryKey: ["connectors", "lookup"] });
      await client.invalidateQueries({ queryKey: ["catalog"] });
      await client.invalidateQueries({ queryKey: ["catalog-categories"] });
      if (route) {
        try {
          const start = await apiRequest<{ authorization_url: string }>(route.start, {
            method: "POST",
          });
          if (start.authorization_url) {
            window.location.assign(start.authorization_url);
            return;
          }
        } catch (failure) {
          onOpenChange(false);
          reportFailure(signInFailure(failure, t), failure);
          return;
        }
      }
      onOpenChange(false);
      toast.success(t(replaced ? "connectorEdit.savedWithKey" : "connectorEdit.saved"));
    },
    onError: (failure) =>
      fail(
        dialogFailure(
          failure instanceof ApiError && failure.message
            ? t("stepEditor.refused", { reason: failure.message })
            : t("common.actionFailed"),
          failure,
        ),
      ),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("connectorEdit.title", { name: prior.name })}
      submit={{ label: t("common.save"), pending: save.isPending }}
      onSubmit={() => {
        if (choice === NEW_CATEGORY && !freshCategory)
          return fail(t("catalogMeta.invalidCategory"));
        const problem = connectorEditProblem(prior, draft, callbackUrl);
        edit("missingHeaders", missingHeaderValues(prior, draft));
        if (problem === "connectorEdit.headersIncomplete") return fail(null);
        if (problem) return fail(t(problem));
        fail(null);
        save.mutate();
      }}
      error={error}
      testId="connector-edit-dialog"
    >
      <TextField
        id="connector-edit-name"
        label={t("create.name")}
        value={name}
        onChange={set("name")}
      />
      <TextAreaField
        id="connector-edit-description"
        label={t("catalogMeta.description")}
        value={description}
        onChange={set("description")}
        rows={3}
        help={t("catalogMeta.descriptionHelp")}
        placeholder={t("catalogMeta.empty")}
      />
      {writtenByAssistant(record) ? (
        <p
          className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
          data-testid="connector-edit-assistant-hint"
        >
          {t("catalogMeta.assistantHint")}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            disabled={accept.isPending}
            onClick={() => accept.mutate()}
            data-testid="catalog-metadata-accept"
          >
            {t("catalogMeta.accept")}
          </Button>
        </p>
      ) : null}
      <SelectField
        id="connector-edit-category"
        label={t("catalogMeta.category")}
        value={choice}
        onChange={set("choice")}
        help={t("catalogMeta.categoryHelp")}
        options={[
          ...choices.map((value) => ({
            value,
            label: humanizeCategory(value, t("catalog.categoryOther")),
          })),
          { value: NEW_CATEGORY, label: t("catalogMeta.newCategory") },
        ]}
      />
      {choice === NEW_CATEGORY ? (
        <TextField
          id="connector-edit-new-category"
          label={t("catalogMeta.newCategoryName")}
          value={fresh}
          onChange={set("fresh")}
          error={fresh.trim() && !freshCategory ? t("catalogMeta.invalidCategory") : null}
        />
      ) : null}
      {prior.address ? (
        <TextField
          id="connector-edit-address"
          type="url"
          label={t("create.connector.address")}
          value={address}
          onChange={set("address")}
          mono
        />
      ) : null}
      {target ? (
        <ConnectorSignInFields
          idPrefix="connector-edit"
          testId="connector-edit-signin"
          target={target}
          signIn={signIn}
          onSignIn={set("signIn")}
          currentDetail={
            priorSignIn === null ? authLabel(prior.authType, headerNames, t) : undefined
          }
          secret={secret}
          onSecret={set("secret")}
          keepsKey={unchangedKind}
          keepsClientSecret={unchangedKind}
          oauth={oauth}
          onOAuth={set("oauth")}
          callbackUrl={callbackUrl}
        />
      ) : null}
      {(!target || signIn === null) && everyHeader
        ? headerNames.map((headerName, index) => (
            <TextField
              key={headerName}
              id={`connector-edit-header-value-${index}`}
              type="password"
              label={t("connectorEdit.headerValue", { name: headerName })}
              placeholder={t("connectorEdit.secretPlaceholder")}
              help={t("connectorEdit.secretHelp")}
              value={headerValues[headerName] ?? ""}
              onChange={(value) => {
                edit("headerValues", (current) => ({ ...current, [headerName]: value }));
                edit("missingHeaders", (current) => current.filter((name) => name !== headerName));
              }}
              error={
                missingHeaders.includes(headerName) ? t("connectorEdit.headersIncomplete") : null
              }
            />
          ))
        : null}
      {(!target || signIn === null) && prior.authType === "header" && !everyHeader ? (
        <TextField
          id="connector-edit-header"
          label={t("connectorCredentials.headerName")}
          value={header}
          onChange={set("typedHeader")}
          mono
        />
      ) : null}
      {prior.authType === "signed_jwt" ? (
        <>
          <TextField
            id="connector-edit-signed-jwt-issuer"
            label={t("connectorEdit.signedJwtIssuer")}
            value={signedJwt.issuer}
            onChange={(issuer) => edit("signedJwt", (current) => ({ ...current, issuer }))}
            mono
          />
          <TextField
            id="connector-edit-signed-jwt-key-id"
            label={t("connectorEdit.signedJwtKeyId")}
            value={signedJwt.keyId}
            onChange={(keyId) => edit("signedJwt", (current) => ({ ...current, keyId }))}
            mono
          />
          <TextField
            id="connector-edit-signed-jwt-subject"
            label={t("connectorEdit.signedJwtSubject")}
            value={signedJwt.subject}
            onChange={(subject) => edit("signedJwt", (current) => ({ ...current, subject }))}
            mono
          />
        </>
      ) : null}
      {(!target || signIn === null) && offersKeyReplacement(prior.authType) && !everyHeader ? (
        <TextField
          id="connector-edit-secret"
          type="password"
          label={t(
            prior.authType === "signed_jwt"
              ? "connectorEdit.signedJwtPrivateKey"
              : "connectorEdit.secret",
          )}
          placeholder={t("connectorEdit.secretPlaceholder")}
          help={t("connectorEdit.secretHelp")}
          value={secret}
          onChange={set("secret")}
        />
      ) : null}
    </FormDialog>
  );
}

export function ConnectorDeleteDialog({
  open,
  onOpenChange,
  id,
  name,
  users,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  id: string;
  name: string;
  users: readonly string[];
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => apiCall("delete", "/v1/connectors/{id}", { path: { id } }),

    onSuccess: async () => {
      toast.success(t("connectorEdit.deleted", { name }));
      onOpenChange(false);
      await client.invalidateQueries({ queryKey: ["catalog"] });
      await client.invalidateQueries({ queryKey: ["connectors", "lookup"] });
      void navigate({ to: "/connectors" });
    },
    onError: (failure) => reportFailure(t("common.actionFailed"), failure),
  });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => !remove.isPending && onOpenChange(next)}
      object={name}
      verb={t("workflowPage.delete")}
      consequence={
        users.length === 0
          ? t("connectorEdit.deleteUnused")
          : t(
              users.length === 1
                ? "connectorEdit.deleteBreaks.one"
                : "connectorEdit.deleteBreaks.other",
              {
                count: users.length,
                names: users.slice(0, 3).join(", "),
              },
            )
      }
      destructive
      pending={remove.isPending}
      onConfirm={async () => {
        await remove.mutateAsync().catch(() => undefined);
      }}
      testId="connector-delete-confirm"
    />
  );
}
