import { ChoiceField, CopyValueField, TextField } from "@/components/cockpit/form-field";
import { useI18n } from "@/lib/i18n-context";
import {
  type ConnectorSignIn,
  type ConnectorTarget,
  type KeyMode,
  needsOAuthClient,
  type OAuthClientFields,
} from "../model/create-connector-model";

type SignInChoice = ConnectorSignIn | "current";

export function ConnectorSignInFields({
  idPrefix,
  testId,
  target,
  signIn,
  onSignIn,
  currentDetail,
  secret,
  onSecret,
  keepsKey,
  keepsClientSecret,
  oauth,
  onOAuth,
  callbackUrl,
  choice = true,
  keyMode,
  onKeyMode,
  header = "",
  onHeader,
}: {
  idPrefix: string;
  testId: string;
  target: ConnectorTarget;
  signIn: ConnectorSignIn | null;
  onSignIn(signIn: ConnectorSignIn | null): void;
  currentDetail?: string;
  secret: string;
  onSecret(secret: string): void;
  keepsKey: boolean;
  keepsClientSecret: boolean;
  oauth: OAuthClientFields;
  onOAuth(oauth: OAuthClientFields): void;
  callbackUrl: string | null;
  choice?: boolean;
  keyMode?: KeyMode;
  onKeyMode?(mode: KeyMode): void;
  header?: string;
  onHeader?(header: string): void;
}) {
  const { t } = useI18n();
  const field = (key: keyof OAuthClientFields) => (value: string) =>
    onOAuth({ ...oauth, [key]: value });
  const oauthFields = signIn !== null && needsOAuthClient(target, signIn);
  return (
    <>
      {choice ? (
        <ChoiceField<SignInChoice>
          label={t("create.connector.signIn")}
          value={signIn ?? "current"}
          onChange={(next) => onSignIn(next === "current" ? null : next)}
          help={t("create.connector.signInHelp")}
          description={signIn === null ? currentDetail : undefined}
          testId={testId}
          options={[
            ...(currentDetail
              ? [{ value: "current" as const, label: t("create.connector.signIn.current") }]
              : []),
            { value: "none", label: t("create.connector.signIn.none") },
            { value: "key", label: t("create.connector.signIn.key") },
            { value: "account", label: t("create.connector.signIn.account") },
          ]}
        />
      ) : null}
      {signIn === "key" && keyMode && onKeyMode ? (
        <ChoiceField<KeyMode>
          label={t("create.connector.keyMode")}
          value={keyMode}
          onChange={onKeyMode}
          testId={`${testId}-key-mode`}
          options={[
            { value: "bearer", label: t("create.connector.keyMode.bearer") },
            { value: "header", label: t("create.connector.keyMode.header") },
          ]}
        />
      ) : null}
      {signIn === "key" && keyMode === "header" && onHeader ? (
        <TextField
          id={`${idPrefix}-header-name`}
          label={t("create.connector.headerName")}
          placeholder="X-API-Key"
          value={header}
          onChange={onHeader}
          required
          mono
        />
      ) : null}
      {signIn === "key" ? (
        <TextField
          id={`${idPrefix}-secret`}
          type="password"
          label={t(keepsKey ? "connectorEdit.secret" : "create.connector.secret")}
          placeholder={t(
            keepsKey ? "connectorEdit.secretPlaceholder" : "create.connector.secretPlaceholder",
          )}
          help={keepsKey ? t("connectorEdit.secretHelp") : undefined}
          value={secret}
          onChange={onSecret}
        />
      ) : null}
      {oauthFields && callbackUrl ? (
        <CopyValueField
          id={`${idPrefix}-callback`}
          label={t("create.connector.callback")}
          value={callbackUrl}
          copyLabel={t("create.connector.copyCallback")}
          help={t("create.connector.callbackHelp")}
        />
      ) : null}
      {oauthFields ? (
        <>
          <TextField
            id={`${idPrefix}-issuer`}
            type="url"
            label={t("create.connector.issuer")}
            placeholder="https://accounts.example.com"
            help={t("create.connector.issuerHelp")}
            value={oauth.issuer}
            onChange={field("issuer")}
            mono
          />
          <TextField
            id={`${idPrefix}-client-id`}
            label={t("create.connector.clientId")}
            value={oauth.clientId}
            onChange={field("clientId")}
            mono
          />
          <TextField
            id={`${idPrefix}-client-secret`}
            type="password"
            label={t("create.connector.clientSecret")}
            placeholder={t(
              keepsClientSecret
                ? "connectorEdit.secretPlaceholder"
                : "create.connector.secretPlaceholder",
            )}
            value={oauth.clientSecret}
            onChange={field("clientSecret")}
          />
          <TextField
            id={`${idPrefix}-scopes`}
            label={t("create.connector.scopes")}
            placeholder={t("create.connector.scopesPlaceholder")}
            value={oauth.scopes}
            onChange={field("scopes")}
            mono
          />
        </>
      ) : null}
    </>
  );
}
