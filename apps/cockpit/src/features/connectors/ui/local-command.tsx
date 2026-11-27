import { IconButton } from "@ui/molecules/icon-button";
import { SquareTerminal, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { ApiError } from "@/api/client";
import { TextAreaField, TextField } from "@/components/cockpit/form-field";
import { Button, CodeBlock, dialogFailure, FormDialog } from "@/components/cockpit/patterns";
import { Alert, AlertDescription, Checkbox } from "@/components/cockpit/patterns/controls";
import { useI18n } from "@/lib/i18n-context";
import { type ConfirmedCommand, useConfirmLocalCommand } from "../hooks/confirm-local-command";
import {
  confirmCommandErrorKey,
  EMPTY_ENV_VAR,
  type EnvVarField,
  type LocalCommandFields,
  type TlsFields,
} from "../model/create-connector-model";

export function LocalCommandFieldset({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: LocalCommandFields;
  onChange(value: LocalCommandFields): void;
}) {
  const { t } = useI18n();
  const envHelpId = useId();
  const setEnv = (index: number, next: Partial<EnvVarField>) =>
    onChange({
      ...value,
      env: value.env.map((entry, at) => (at === index ? { ...entry, ...next } : entry)),
    });
  return (
    <div className="flex flex-col gap-3" data-testid={`${idPrefix}-local-command`}>
      <TextField
        id={`${idPrefix}-command`}
        label={t("connectorLocal.command")}
        placeholder="docker"
        help={t("connectorLocal.commandHelp")}
        value={value.command}
        onChange={(command) => onChange({ ...value, command })}
        required
        mono
      />
      <TextAreaField
        id={`${idPrefix}-args`}
        label={t("connectorLocal.args")}
        placeholder={"mcp\ngateway\nrun"}
        help={t("connectorLocal.argsHelp")}
        rows={3}
        value={value.args}
        onChange={(args) => onChange({ ...value, args })}
        mono
      />
      <fieldset className="flex min-w-0 flex-col gap-2" aria-describedby={envHelpId}>
        <legend className="text-sm font-medium">{t("connectorLocal.env")}</legend>
        <p id={envHelpId} className="text-xs text-muted-foreground">
          {t("connectorLocal.envHelp")}
        </p>
        {value.env.map((entry, index) => {
          const rowId = `${idPrefix}-env-${index}`;
          const label = entry.name.trim() || t("connectorLocal.envUnnamed");
          return (
            <div
              key={index}
              className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto_auto]"
              data-testid={rowId}
            >
              <TextField
                id={`${rowId}-name`}
                label={t("connectorLocal.envName")}
                value={entry.name}
                onChange={(name) => setEnv(index, { name })}
                mono
              />
              <TextField
                id={`${rowId}-value`}
                type={entry.secret ? "password" : "text"}
                label={t("connectorLocal.envValue")}
                value={entry.value}
                onChange={(next) => setEnv(index, { value: next })}
                mono
              />
              <label
                htmlFor={`${rowId}-secret`}
                className="flex min-h-10 items-center gap-2 text-sm sm:min-h-8"
              >
                <Checkbox
                  id={`${rowId}-secret`}
                  checked={entry.secret}
                  onCheckedChange={(checked) => setEnv(index, { secret: checked === true })}
                  data-testid={`${rowId}-secret`}
                />
                {t("connectorLocal.envSecret")}
              </label>
              <IconButton
                label={t("connectorLocal.envRemove", { name: label })}
                onClick={() =>
                  onChange({ ...value, env: value.env.filter((_, at) => at !== index) })
                }
                data-testid={`${rowId}-remove`}
              >
                <Trash2 aria-hidden="true" />
              </IconButton>
            </div>
          );
        })}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange({ ...value, env: [...value.env, { ...EMPTY_ENV_VAR }] })}
            data-testid={`${idPrefix}-env-add`}
          >
            {t("connectorLocal.envAdd")}
          </Button>
        </div>
      </fieldset>
      <TextField
        id={`${idPrefix}-cwd`}
        label={t("connectorLocal.cwd")}
        placeholder="/Users/me/project"
        help={t("connectorLocal.cwdHelp")}
        value={value.cwd}
        onChange={(cwd) => onChange({ ...value, cwd })}
        mono
      />
    </div>
  );
}

export function TlsFieldset({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: TlsFields;
  onChange(value: TlsFields): void;
}) {
  const { t } = useI18n();
  const file = useRef<HTMLInputElement>(null);
  const [fileFailed, setFileFailed] = useState(false);
  const warningId = `${idPrefix}-tls-skip-warning`;
  return (
    <div className="flex flex-col gap-3" data-testid={`${idPrefix}-tls`}>
      <TextAreaField
        id={`${idPrefix}-tls-ca`}
        label={t("create.connector.tls.ca")}
        placeholder="-----BEGIN CERTIFICATE-----"
        help={t("create.connector.tls.caHelp")}
        rows={4}
        value={value.caPem}
        onChange={(caPem) => onChange({ ...value, caPem })}
        error={fileFailed ? t("create.connector.tls.caFileFailed") : null}
        mono
      />
      <div>
        <input
          ref={file}
          type="file"
          accept=".pem,.crt,.cer,application/x-pem-file,application/x-x509-ca-cert"
          className="hidden"
          tabIndex={-1}
          aria-label={t("create.connector.tls.caFile")}
          data-testid={`${idPrefix}-tls-ca-file`}
          onChange={async (event) => {
            const picked = event.target.files?.[0];
            event.target.value = "";
            if (!picked) return;
            try {
              onChange({ ...value, caPem: await picked.text() });
              setFileFailed(false);
            } catch {
              setFileFailed(true);
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => file.current?.click()}
          data-testid={`${idPrefix}-tls-ca-pick`}
        >
          {t("create.connector.tls.caFile")}
        </Button>
      </div>
      <label htmlFor={`${idPrefix}-tls-skip`} className="flex items-center gap-2 text-sm">
        <Checkbox
          id={`${idPrefix}-tls-skip`}
          checked={value.skipVerify}
          onCheckedChange={(checked) => onChange({ ...value, skipVerify: checked === true })}
          aria-describedby={value.skipVerify ? warningId : undefined}
          data-testid={`${idPrefix}-tls-skip`}
        />
        {t("create.connector.tls.skipVerify")}
      </label>
      {value.skipVerify ? (
        <p id={warningId} className="text-xs text-warning-ink" data-testid={warningId}>
          {t("create.connector.tls.skipVerifyWarning")}
        </p>
      ) : null}
    </div>
  );
}

export function CommandLineBlock({ line, testId }: { line: string; testId: string }) {
  return <CodeBlock code={line} lang="shell" testId={testId} />;
}

export function confirmCommandFailure(
  failure: unknown,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const key = failure instanceof ApiError ? confirmCommandErrorKey(failure.code) : null;
  return t(key ?? "connectorLocal.error.failed");
}

export function CommandConfirmBody({ line, testId }: { line: string; testId: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium">{t("connectorLocal.confirm.commandLabel")}</p>
      <CommandLineBlock line={line} testId={`${testId}-line`} />
      <p className="text-xs text-muted-foreground">{t("connectorLocal.confirm.envNote")}</p>
    </div>
  );
}

export function CommandConfirmDialog({
  open,
  onOpenChange,
  connectorId,
  config,
  commandLine,
  onConfirmed,
  testId = "connector-command-confirm",
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  connectorId: string;
  config: unknown;
  commandLine: string;
  onConfirmed(result: ConfirmedCommand): void | Promise<void>;
  testId?: string;
}) {
  const { t } = useI18n();
  const confirm = useConfirmLocalCommand({
    onSuccess: async (result) => {
      await onConfirmed(result);
      onOpenChange(false);
    },
  });
  const close = (next: boolean) => {
    if (confirm.isPending) return;
    if (!next) confirm.reset();
    onOpenChange(next);
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={t("connectorLocal.confirm.title")}
      description={t("connectorLocal.confirm.body")}
      submit={{
        label: t("connectorLocal.confirm.allow"),
        pending: confirm.isPending,
        testId: `${testId}-allow`,
      }}
      onSubmit={() => confirm.mutate({ id: connectorId, config })}
      cancelLabel={t("connectorLocal.confirm.cancel")}
      cancelTestId={`${testId}-cancel`}
      error={
        confirm.isError
          ? dialogFailure(confirmCommandFailure(confirm.error, t), confirm.error)
          : undefined
      }
      testId={testId}
    >
      <CommandConfirmBody line={commandLine} testId={testId} />
    </FormDialog>
  );
}

export function CommandUnconfirmedBanner({
  commandLine,
  canConfirm,
  onAllow,
}: {
  commandLine: string;
  canConfirm: boolean;
  onAllow(): void;
}) {
  const { t } = useI18n();
  return (
    <Alert data-testid="connector-command-unconfirmed">
      <SquareTerminal aria-hidden="true" />
      <AlertDescription className="flex flex-col gap-2">
        <p className="font-medium text-foreground">{t("connectorLocal.banner.title")}</p>
        <p>{t("connectorLocal.banner.body")}</p>
        <CommandLineBlock line={commandLine} testId="connector-command-unconfirmed-line" />
        {!canConfirm ? <p>{t("connectorLocal.banner.askAdmin")}</p> : null}
        {canConfirm ? (
          <div>
            <Button
              type="button"
              size="sm"
              onClick={onAllow}
              data-testid="connector-command-unconfirmed-allow"
            >
              {t("connectorLocal.banner.action")}
            </Button>
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
