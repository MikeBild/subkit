import { useState } from "react";
import { ChoiceField } from "@/components/cockpit/form-field";
import { dialogFailure, FormDialog } from "@/components/cockpit/patterns";
import {
  detectFormat,
  type ImportFormat,
  type ImportRow,
  importCounts,
  importErrorKey,
  importFileProblem,
  importRows,
  ROW_STATUS_KEYS,
} from "@/features/vault/model/import";
import {
  VAULT_SCOPE_LABEL,
  type VaultEnvironment,
  type VaultScope,
} from "@/features/vault/model/vault";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useVaultImport } from "./hooks/use-vault-payments";

const FORMAT_NAMES: Readonly<Record<ImportFormat, string>> = {
  chrome: "Chrome",
  "1password": "1Password",
  bitwarden: "Bitwarden",
};

interface Loaded {
  csv: string;
  format: ImportFormat | null;
}

export function ImportPreview({ rows }: { rows: readonly ImportRow[] }) {
  const { t } = useI18n();
  const counts = importCounts(rows);
  return (
    <div className="grid gap-2" data-testid="vault-import-preview">
      <p className="text-sm" role="status">
        {t("vault.import.summary", {
          new: counts.new,
          exists: counts.exists,
          invalid: counts.invalid,
        })}
      </p>
      <div className="max-h-64 overflow-auto rounded-lg border">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-muted">
            <tr>
              <th scope="col" className="px-2 py-1.5 font-medium">
                {t("vault.import.column.name")}
              </th>
              <th scope="col" className="px-2 py-1.5 font-medium">
                {t("vault.import.column.website")}
              </th>
              <th scope="col" className="px-2 py-1.5 font-medium">
                {t("vault.import.column.username")}
              </th>
              <th scope="col" className="px-2 py-1.5 font-medium">
                {t("vault.import.column.totp")}
              </th>
              <th scope="col" className="px-2 py-1.5 font-medium">
                {t("vault.import.column.status")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row, index) => (
              <tr key={`${row.name}-${index}`} data-status={row.status}>
                <td className="px-2 py-1.5 font-mono [overflow-wrap:anywhere]">{row.name}</td>
                <td className="px-2 py-1.5 [overflow-wrap:anywhere]">{row.origin ?? "—"}</td>
                <td className="px-2 py-1.5">{row.usernameHint ?? "—"}</td>
                <td className="px-2 py-1.5">{row.hasTotp ? "✓" : "—"}</td>
                <td className="px-2 py-1.5">{t(ROW_STATUS_KEYS[row.status])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ImportDialog({
  open,
  canWriteWorkspace,
  onClose,
  onImported,
}: {
  open: boolean;
  canWriteWorkspace: boolean;
  onClose(): void;
  onImported(count: number): void;
}) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fileProblem, setFileProblem] = useState<TranslationKey | null>(null);
  const [scope, setScope] = useState<VaultScope>(canWriteWorkspace ? "workspace" : "person");
  const [environment, setEnvironment] = useState<VaultEnvironment>("prod");
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const run = useVaultImport();
  const close = () => {
    setLoaded(null);
    setRows(null);
    setFileProblem(null);
    setFailure(null);
    run.reset();
    onClose();
  };
  const choose = async (file: File | undefined) => {
    setRows(null);
    setFailure(null);
    setLoaded(null);
    if (!file) return;
    const problem = importFileProblem(file);
    setFileProblem(problem);
    if (problem) return;
    try {
      const csv = await file.text();
      setLoaded({ csv, format: detectFormat(csv) });
    } catch {
      setFileProblem("vault.import.error.read");
    }
  };
  const format = loaded?.format ?? null;
  const fresh = rows ? importCounts(rows).new : 0;
  const submit = () => {
    if (!loaded || !format) return;
    const dryRun = rows === null;
    if (!dryRun && fresh === 0) return;
    setFailure(null);
    run.mutate(
      { format, csv: loaded.csv, scope, environment, dry_run: dryRun },
      {
        onSuccess: (result) => {
          run.reset();
          if (dryRun) {
            setRows(importRows(result));
            return;
          }
          const created = result.created ?? fresh;
          setLoaded(null);
          setRows(null);
          onImported(created);
        },
        onError: (error) => {
          run.reset();
          setFailure(error);
        },
      },
    );
  };
  const fileError = fileProblem
    ? t(fileProblem)
    : loaded && !format
      ? t("vault.import.unknownFormat")
      : null;
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={t("vault.import.title")}
      description={t("vault.import.description")}
      size="wide"
      submit={{
        label: rows ? t("vault.import.submit", { count: fresh }) : t("vault.import.preview"),
        pending: run.isPending,
        disabled: !format || (rows !== null && fresh === 0),
        testId: "vault-import-submit",
      }}
      onSubmit={submit}
      error={failure ? dialogFailure(t(importErrorKey(failure)), failure) : null}
      testId="vault-import"
    >
      <div className="grid gap-4">
        <div className="grid gap-1.5" data-invalid={fileError ? true : undefined}>
          <label htmlFor="vault-import-file" className="text-sm font-medium">
            {t("vault.import.file")}
          </label>
          <input
            id="vault-import-file"
            type="file"
            accept=".csv,text/csv"
            aria-describedby={`vault-import-file-help${fileError ? " vault-import-file-error" : ""}`}
            aria-invalid={fileError ? true : undefined}
            onChange={(event) => void choose(event.target.files?.[0])}
            className="text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1"
            data-testid="vault-import-file"
          />
          <p id="vault-import-file-help" className="text-xs text-muted-foreground">
            {t("vault.import.fileHelp")}
          </p>
          {fileError ? (
            <p id="vault-import-file-error" role="alert" className="text-xs text-destructive">
              {fileError}
            </p>
          ) : format ? (
            <p className="text-xs text-muted-foreground" data-testid="vault-import-format">
              {t("vault.import.detected", { format: FORMAT_NAMES[format] })}
            </p>
          ) : null}
        </div>
        <ChoiceField<VaultScope>
          label={t("vault.field.scope")}
          value={scope}
          onChange={(next) => {
            setScope(next);
            setRows(null);
          }}
          options={(canWriteWorkspace
            ? (["workspace", "person"] as const)
            : (["person"] as const)
          ).map((value) => ({ value, label: t(VAULT_SCOPE_LABEL[value]) }))}
          testId="vault-import-scope"
        />
        <ChoiceField<VaultEnvironment>
          label={t("vault.field.environment")}
          value={environment}
          onChange={(next) => {
            setEnvironment(next);
            setRows(null);
          }}
          options={[
            { value: "prod", label: t("environmentChip.prod") },
            { value: "dev", label: t("environmentChip.dev") },
          ]}
          testId="vault-import-environment"
        />
        {rows && fresh === 0 ? (
          <p className="text-sm" role="status" data-testid="vault-import-nothing">
            {t("vault.import.nothingNew")}
          </p>
        ) : null}
        {rows ? <ImportPreview rows={rows} /> : null}
      </div>
    </FormDialog>
  );
}
