import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { useSession } from "@/app/session";
import {
  categoryChoices,
  metadataPatch,
  normalizeCategoryInput,
  recordCategory,
  recordDescription,
  writtenByAssistant,
} from "@/components/cockpit/catalog-metadata-model";
import { ConnectorSignInFields } from "@/components/cockpit/connector-sign-in-fields";
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
} from "@/components/cockpit/create-connector-model";
import { SelectField, TextAreaField, TextField } from "@/components/cockpit/form-field";
import { Button, ConfirmDialog, FormDialog } from "@/components/cockpit/patterns";
import { connectorSignIn, signInFailure } from "@/lib/connector-sign-in";
import { useI18n } from "@/lib/i18n-context";
import { humanizeCategory } from "@/lib/workflow-category";
import { authLabel, offersKeyReplacement } from "@/pages/connector-detail-model";

const NEW_CATEGORY = "__new__";

type Connector = components["schemas"]["Connector"];

type RecordValue = Record<string, unknown>;

const text = (record: RecordValue, key: string): string =>
  typeof record[key] === "string" ? (record[key] as string) : "";

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
  const [name, setName] = useState(prior.name);
  const [address, setAddress] = useState(prior.address);
  const [signIn, setSignIn] = useState<ConnectorSignIn | null>(priorSignIn);
  const [secret, setSecret] = useState("");
  const [oauth, setOAuth] = useState<OAuthClientFields>(() => oauthClientOf(prior.config));
  const [signedJwt, setSignedJwt] = useState(() => signedJwtFieldsOf(prior.config));
  const [typedHeader, setHeader] = useState<string | null>(null);
  const header = typedHeader ?? headerNames[0] ?? "";
  const [headerValues, setHeaderValues] = useState<Record<string, string>>({});
  const [missingHeaders, setMissingHeaders] = useState<readonly string[]>([]);
  const everyHeader = replacesEveryHeader(prior);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState(() => recordDescription(record));
  const [choice, setChoice] = useState(() => recordCategory(record));
  const [fresh, setFresh] = useState("");
  useEffect(() => {
    if (!open) return;
    setDescription(recordDescription(record));
    setChoice(recordCategory(record));
    setFresh("");
  }, [open, record]);
  const vocabulary = useQuery({
    queryKey: ["catalog-categories"],
    enabled: open,
    queryFn: () => apiRequest<{ categories?: { category: string }[] }>("/v1/categories"),
  });
  const choices = categoryChoices(
    (vocabulary.data?.categories ?? []).map((entry) => entry.category),
    recordCategory(record),
  );
  const freshCategory = choice === NEW_CATEGORY ? normalizeCategoryInput(fresh) : null;
  const category = choice === NEW_CATEGORY ? (freshCategory ?? "") : choice;
  const accept = useMutation({
    mutationFn: () =>
      apiRequest(`/v1/connectors/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ description: recordDescription(record), accept_description: true }),
      }),
    onSuccess: async () => {
      toast.success(t("catalogMeta.saved"));
      await client.invalidateQueries({ queryKey: ["catalog-detail", "connectors", id] });
      await client.invalidateQueries({ queryKey: ["catalog"] });
    },
    onError: () => toast.error(t("detail.saveFailed")),
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
      const path = `/v1/connectors/${encodeURIComponent(id)}`;
      const metadata = category ? metadataPatch(record, { description, category }) : null;
      const connector = await apiRequest<Connector>(path, {
        method: "PATCH",
        body: JSON.stringify({ ...plan.patch, ...metadata }),
      });
      if (plan.credential)
        await apiRequest(`${path}/credentials`, {
          method: "POST",
          body: JSON.stringify(plan.credential),
        });
      return {
        replaced: Boolean(plan.credential),
        route: plan.startSignIn ? connectorSignIn(connector) : null,
      };
    },
    onSuccess: async ({ replaced, route }) => {
      setSecret("");
      setHeaderValues({});
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
          toast.error(signInFailure(failure, t));
          return;
        }
      }
      onOpenChange(false);
      toast.success(t(replaced ? "connectorEdit.savedWithKey" : "connectorEdit.saved"));
    },
    onError: (failure) =>
      setError(
        failure instanceof ApiError && failure.message
          ? t("stepEditor.refused", { reason: failure.message })
          : t("common.actionFailed"),
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
          return setError(t("catalogMeta.invalidCategory"));
        const problem = connectorEditProblem(prior, draft, callbackUrl);
        setMissingHeaders(missingHeaderValues(prior, draft));
        if (problem === "connectorEdit.headersIncomplete") return setError(null);
        if (problem) return setError(t(problem));
        setError(null);
        save.mutate();
      }}
      error={error}
      testId="connector-edit-dialog"
    >
      <TextField
        id="connector-edit-name"
        label={t("create.name")}
        value={name}
        onChange={setName}
      />
      <TextAreaField
        id="connector-edit-description"
        label={t("catalogMeta.description")}
        value={description}
        onChange={setDescription}
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
        onChange={setChoice}
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
          onChange={setFresh}
          error={fresh.trim() && !freshCategory ? t("catalogMeta.invalidCategory") : null}
        />
      ) : null}
      {prior.address ? (
        <TextField
          id="connector-edit-address"
          type="url"
          label={t("create.connector.address")}
          value={address}
          onChange={setAddress}
          mono
        />
      ) : null}
      {target ? (
        <ConnectorSignInFields
          idPrefix="connector-edit"
          testId="connector-edit-signin"
          target={target}
          signIn={signIn}
          onSignIn={setSignIn}
          currentDetail={
            priorSignIn === null ? authLabel(prior.authType, headerNames, t) : undefined
          }
          secret={secret}
          onSecret={setSecret}
          keepsKey={unchangedKind}
          keepsClientSecret={unchangedKind}
          oauth={oauth}
          onOAuth={setOAuth}
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
                setHeaderValues((current) => ({ ...current, [headerName]: value }));
                setMissingHeaders((current) => current.filter((name) => name !== headerName));
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
          onChange={setHeader}
          mono
        />
      ) : null}
      {prior.authType === "signed_jwt" ? (
        <>
          <TextField
            id="connector-edit-signed-jwt-issuer"
            label={t("connectorEdit.signedJwtIssuer")}
            value={signedJwt.issuer}
            onChange={(issuer) => setSignedJwt((current) => ({ ...current, issuer }))}
            mono
          />
          <TextField
            id="connector-edit-signed-jwt-key-id"
            label={t("connectorEdit.signedJwtKeyId")}
            value={signedJwt.keyId}
            onChange={(keyId) => setSignedJwt((current) => ({ ...current, keyId }))}
            mono
          />
          <TextField
            id="connector-edit-signed-jwt-subject"
            label={t("connectorEdit.signedJwtSubject")}
            value={signedJwt.subject}
            onChange={(subject) => setSignedJwt((current) => ({ ...current, subject }))}
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
          onChange={setSecret}
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
    mutationFn: () => apiRequest(`/v1/connectors/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      toast.success(t("connectorEdit.deleted", { name }));
      onOpenChange(false);
      await client.invalidateQueries({ queryKey: ["catalog"] });
      await client.invalidateQueries({ queryKey: ["connectors", "lookup"] });
      void navigate({ to: "/connectors" });
    },
    onError: () => toast.error(t("common.actionFailed")),
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
