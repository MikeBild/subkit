import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DropZone } from "@ui/molecules/drop-zone";
import { useEffect, useMemo, useRef, useState } from "react";
import { getIntakeDefaultCategory, listIntakeCategories } from "@/api/intake";
import {
  confirmInstallationImport,
  type InstallationImportDraft,
  prepareInstallationImport,
} from "@/app/installation-import";
import { useInstallation } from "@/app/installation-provider";
import { useSession } from "@/app/session";
import { SelectField } from "@/components/cockpit/form-field";
import { FilePreview, FormDialog, useFileGate } from "@/components/cockpit/patterns";
import { humanizeCategory } from "@/features/workflows/model";
import { readClipboardText } from "@/lib/clipboard";
import { useI18n } from "@/lib/i18n-context";
import { InstallationInputActions } from "./installation-dialogs";

const IMPORT_ACCEPT = ".txt,.md,.csv,.json,.pdf";
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export function InstallationImportDialog() {
  const { t } = useI18n();
  const gateImport = useFileGate({ accept: IMPORT_ACCEPT, maxBytes: IMPORT_MAX_BYTES });
  const session = useSession();
  const client = useQueryClient();
  const { incoming, incomingError, stageIncoming, clearIncoming } = useInstallation();
  const [draft, setDraft] = useState<InstallationImportDraft | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preparation = useRef(0);
  const open = Boolean(incoming || incomingError || draft || error);
  const categories = useQuery({
    queryKey: ["catalog-categories"],
    queryFn: listIntakeCategories,
    enabled: open,
  });
  const defaultCategory = useQuery({
    queryKey: ["intake", "default-category"],
    queryFn: getIntakeDefaultCategory,
    enabled: open,
  });
  const locked = draft?.category !== undefined;
  const destination = draft?.category ?? category ?? defaultCategory.data?.category ?? "";
  const categoryLabel = humanizeCategory(destination, t("catalog.categoryOther"));
  const options = useMemo(() => {
    const names = new Set<string>();
    if (defaultCategory.data) names.add(defaultCategory.data.category);
    for (const item of categories.data?.categories ?? []) names.add(item.category);
    names.add(destination);
    return [...names].map((name) => ({
      value: name,
      label: humanizeCategory(name, t("catalog.categoryOther")),
    }));
  }, [categories.data?.categories, defaultCategory.data, destination, t]);
  const needsFileWrite = Boolean(draft?.records.some((record) => record.file));
  const canImport =
    session.permissions.includes("intake:write") &&
    (!needsFileWrite || session.permissions.includes("file:write"));

  useEffect(() => {
    if (!incoming || draft) return;
    const generation = ++preparation.current;
    void prepareInstallationImport(incoming, {
      tenantId: session.tenant.id,
      userId: session.principal.id,
    })
      .then((prepared) => {
        if (generation !== preparation.current) return;
        setDraft(prepared);
        setError(null);
      })
      .catch(() => {
        if (generation === preparation.current) setError(t("installation.importFailed"));
      });
  }, [defaultCategory.data?.category, draft, incoming, session.principal.id, session.tenant.id, t]);

  const replaceIncoming = (value: Parameters<typeof stageIncoming>[0]) => {
    if (locked || pending) return;
    preparation.current += 1;
    setDraft(null);
    setError(null);
    stageIncoming(value);
  };
  const addFiles = (files: File[]) => {
    replaceIncoming({ title: "", text: "", url: "", files });
  };
  const clipboard = async () => {
    if (locked || pending) return;
    try {
      replaceIncoming({
        title: "",
        text: await readClipboardText(),
        url: "",
        files: [],
      });
    } catch {
      setError(t("installation.importFailed"));
    }
  };
  const submit = async () => {
    if (!draft || (category === null && !defaultCategory.data)) return;
    if (!canImport) {
      setError(t("installation.permission"));
      return;
    }
    setPending(true);
    try {
      await confirmInstallationImport(draft, {
        tenantId: session.tenant.id,
        userId: session.principal.id,
        category: destination,
      });
      void client.invalidateQueries({ queryKey: ["catalog"] });
      clearIncoming();
      setDraft(null);
      setError(null);
    } catch {
      setError(t("installation.importFailed"));
    } finally {
      setPending(false);
    }
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) {
          preparation.current += 1;
          clearIncoming();
          setDraft(null);
          setCategory(null);
          setError(null);
        }
      }}
      title={t("installation.importTitle", { category: categoryLabel })}
      description={t("installation.importHint")}
      submit={{
        label: t("installation.importAction", { category: categoryLabel }),
        pending,
        disabled:
          !draft ||
          draft.records.length === 0 ||
          !canImport ||
          (category === null && !defaultCategory.data),
      }}
      onSubmit={submit}
      error={
        error ??
        (defaultCategory.error && category === null ? t("installation.importFailed") : null) ??
        (incomingError ? t("installation.importFailed") : null) ??
        (draft && !canImport ? t("installation.permission") : null)
      }
      testId="installation-import-dialog"
    >
      <SelectField
        id="installation-import-category"
        label={t("intake.category")}
        value={destination}
        onChange={locked ? () => {} : setCategory}
        options={locked ? [{ value: destination, label: categoryLabel }] : options}
      />
      <DropZone
        multiple
        accept={IMPORT_ACCEPT}
        disabled={locked || pending}
        onFiles={(files) => addFiles(gateImport(files))}
        title={t("platform.file.drop")}
        hint={t("installation.importHint")}
        testId="installation-import-drop"
      />
      <InstallationInputActions
        onFiles={addFiles}
        onClipboard={() => void clipboard()}
        disabled={locked || pending}
      />
      {draft?.records.map((record) => (
        <div key={record.requestId} className="grid gap-2 rounded-lg border p-3 text-sm">
          {record.file ? (
            <FilePreview
              name={record.file.name}
              file={record.file}
              testId={`installation-import-preview-${record.requestId}`}
            />
          ) : (
            <p className="font-medium">{record.title}</p>
          )}
          <p className="whitespace-pre-wrap break-words text-muted-foreground">{record.body}</p>
          {record.sourceUrl ? (
            <p className="break-all text-xs text-muted-foreground">{record.sourceUrl}</p>
          ) : null}
        </div>
      ))}
      {error && draft?.records.some((record) => record.fileId || record.itemId) ? (
        <p className="text-xs text-muted-foreground">{t("installation.importPartial")}</p>
      ) : null}
    </FormDialog>
  );
}
