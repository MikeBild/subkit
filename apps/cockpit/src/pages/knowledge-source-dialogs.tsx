import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiCall, apiMultipart } from "@/api/call";
import { ApiError } from "@/api/client";
import { recordHref } from "@/app/links";
import {
  DataState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FileDrop,
  FilePreview,
  FormDialog,
  Input,
  MarkdownEditor,
  SegmentedControl,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { refreshFields, refreshRhythm } from "@/pages/knowledge-sources-model";
import { type OfferedRhythm, RefreshField, rhythmLabel } from "./knowledge-source-refresh";
import { urlSourceBody } from "./knowledge-source-request";

type KnowledgeSource = components["schemas"]["KnowledgeSource"];
export type AddMode = "url" | "file" | "text";
export type EditMode = "address" | "text";
const ENDPOINT = "/v1/knowledge-sources";

export function AddSourceDialog({
  open,
  initialMode,
  initialName,
  onOpenChange,
}: {
  open: boolean;
  initialMode: AddMode;
  initialName: string;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [mode, setMode] = useState<AddMode>(initialMode);
  const [url, setUrl] = useState("");
  const [rhythm, setRhythm] = useState<OfferedRhythm>("weekly");
  const [name, setName] = useState(initialName);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setName(initialName);
      return;
    }
    setUrl("");
    setRhythm("weekly");
    setName("");
    setText("");
    setFile(null);
    setProblem(null);
  }, [open, initialMode, initialName]);

  const create = useMutation({
    mutationFn: async (): Promise<KnowledgeSource> => {
      if (mode === "url")
        return apiCall("post", "/v1/knowledge-sources/url", { body: urlSourceBody(url, rhythm) });
      if (mode === "text")
        return apiCall("post", "/v1/knowledge-sources/inline", {
          body: { name: name.trim(), content: text, mime_type: "text/markdown" },
        });
      return apiMultipart(ENDPOINT, {
        body: {
          file: file as File,
          metadata: JSON.stringify({ name: name.trim() || (file as File).name }),
        },
      });
    },
    onSuccess: async (source) => {
      toast.success(t("knowledge.added", { name: source.name }));
      await client.invalidateQueries({ queryKey: ["catalog"] });
      onOpenChange(false);
      void navigate({ to: recordHref("knowledge", source.id) });
    },
    onError: (error) =>
      setProblem(
        error instanceof ApiError && error.status === 422
          ? t("knowledge.add.unreadable")
          : error instanceof ApiError && error.status === 413
            ? t("knowledge.add.tooLarge")
            : t("common.actionFailed"),
      ),
  });

  const submit = () => {
    setProblem(null);
    if (mode === "url" && !/^https?:\/\/\S+\.\S+/.test(url.trim()))
      return setProblem(t("knowledge.add.urlMissing"));
    if (mode === "text" && !name.trim()) return setProblem(t("knowledge.add.nameMissing"));
    if (mode === "text" && !text.trim()) return setProblem(t("knowledge.add.textMissing"));
    if (mode === "file" && !file) return setProblem(t("knowledge.add.fileMissing"));
    create.mutate();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("knowledge.add")}
      size={mode === "text" ? "wide" : "default"}
      submit={{ label: t("knowledge.add.submit"), pending: create.isPending }}
      onSubmit={submit}
      testId="knowledge-add-dialog"
    >
      <SegmentedControl
        label={t("knowledge.add.mode")}
        value={mode}
        onValueChange={(next) => {
          setMode(next as AddMode);
          setProblem(null);
        }}
        options={[
          { value: "url", label: t("knowledge.kind.url"), testId: "knowledge-add-mode-url" },
          { value: "file", label: t("knowledge.add.modeFile"), testId: "knowledge-add-mode-file" },
          { value: "text", label: t("knowledge.kind.text"), testId: "knowledge-add-mode-text" },
        ]}
        testId="knowledge-add-mode"
      />
      {mode === "url" ? (
        <Field>
          <FieldLabel htmlFor="knowledge-add-url">{t("knowledge.field.url")}</FieldLabel>
          <Input
            id="knowledge-add-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://docs.example.com/handbuch"
            data-testid="knowledge-add-url"
          />
          <FieldDescription>{t("knowledge.add.urlHelp")}</FieldDescription>
        </Field>
      ) : null}
      {mode === "url" ? <RefreshField value={rhythm} onChange={setRhythm} /> : null}
      {mode === "file" ? (
        <>
          <FileDrop
            onFiles={(files) => setFile(files[0] ?? null)}
            accept=".md,.markdown,.txt,.csv,.json,.html,.pdf,.docx,text/*"
            testId="knowledge-add-file"
          />
          {file ? (
            <FilePreview name={file.name} file={file} testId="knowledge-add-file-preview" />
          ) : null}
        </>
      ) : null}
      {mode === "text" ? (
        <>
          <Field>
            <FieldLabel htmlFor="knowledge-add-name">{t("common.name")}</FieldLabel>
            <Input
              id="knowledge-add-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("knowledge.add.namePlaceholder")}
              data-testid="knowledge-add-name"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="knowledge-add-text">{t("knowledge.field.text")}</FieldLabel>
            <MarkdownEditor
              id="knowledge-add-text"
              label={t("knowledge.field.text")}
              value={text}
              onChange={setText}
              placeholder={t("knowledge.add.textPlaceholder")}
              rows={10}
              testId="knowledge-add-text"
            />
          </Field>
        </>
      ) : null}
      {problem ? <FieldError data-testid="knowledge-add-error">{problem}</FieldError> : null}
    </FormDialog>
  );
}

export function EditSourceDialog({
  source,
  mode,
  onOpenChange,
}: {
  source: KnowledgeSource;
  mode: EditMode | null;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const open = mode !== null;
  const content = useQuery({
    queryKey: ["knowledge-source", source.id, "content"],
    queryFn: () =>
      apiCall("get", "/v1/knowledge-sources/{id}/content", { path: { id: source.id } }),
    enabled: mode === "text",
  });
  const document =
    content.data?.editable && content.data.documents.length === 1
      ? content.data.documents[0]
      : undefined;
  const savedRhythm = refreshRhythm(source.refresh_strategy, source.refresh_cron);
  const [address, setAddress] = useState(source.source_uri);
  const [note, setNote] = useState("");
  const [rhythm, setRhythm] = useState<OfferedRhythm | null>(null);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setAddress(source.source_uri);
      setNote("");
      setRhythm(savedRhythm === "custom" ? null : savedRhythm);
      setProblem(null);
    }
  }, [open, source.source_uri, savedRhythm]);
  useEffect(() => setText(document?.content ?? ""), [document?.content]);

  const save = useMutation({
    mutationFn: async () => {
      if (mode === "address") {
        const rhythmChanged = rhythm !== null && rhythm !== savedRhythm;
        const addressChanged = address.trim() !== source.source_uri;
        if (rhythmChanged || addressChanged)
          await apiCall("patch", "/v1/knowledge-sources/{id}", {
            path: { id: source.id },
            body: {
              ...(rhythmChanged && rhythm ? refreshFields(rhythm) : {}),
              ...(addressChanged ? { source_uri: address.trim() } : {}),
            },
          });
        return;
      }
      if (document && content.data && text !== document.content)
        await apiCall("put", "/v1/knowledge-sources/{id}/content", {
          path: { id: source.id },
          body: {
            expected_version: content.data.version,
            path: document.path,
            content: text,
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        });
    },
    onSuccess: async () => {
      toast.success(t("detail.saved"));
      await client.invalidateQueries({ queryKey: ["knowledge-source", source.id] });
      onOpenChange(false);
    },
    onError: (error) =>
      setProblem(
        error instanceof ApiError && error.status === 409
          ? t("knowledge.edit.conflict")
          : t("detail.saveFailed"),
      ),
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={mode === "address" ? t("knowledge.editAddress") : t("knowledge.editText")}
      size={mode === "text" ? "wide" : "default"}
      submit={{
        label: t("common.save"),
        pending: save.isPending,
        disabled: mode === "address" ? !address.trim() : !document,
      }}
      onSubmit={() => save.mutate()}
      testId="knowledge-edit-dialog"
    >
      {mode === "address" ? (
        <>
          <Field>
            <FieldLabel htmlFor="knowledge-edit-address">{t("knowledge.field.url")}</FieldLabel>
            <Input
              id="knowledge-edit-address"
              type="url"
              required
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              data-testid="knowledge-edit-address"
            />
          </Field>
          <RefreshField
            value={rhythm}
            onChange={setRhythm}
            current={savedRhythm === "custom" ? rhythmLabel(t, source) : undefined}
          />
        </>
      ) : content.isPending ? (
        <DataState state="loading" />
      ) : document ? (
        <>
          <Field>
            <FieldLabel htmlFor="knowledge-edit-text">{t("knowledge.field.text")}</FieldLabel>
            <MarkdownEditor
              id="knowledge-edit-text"
              label={t("knowledge.field.text")}
              value={text}
              onChange={setText}
              rows={14}
              testId="knowledge-edit-text"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="knowledge-edit-note">
              {t("knowledge.versions.column.why")}
            </FieldLabel>
            <Input
              id="knowledge-edit-note"
              value={note}
              disabled={text === document.content}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
              data-testid="knowledge-edit-note"
            />
          </Field>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t("knowledge.edit.notEditable")}</p>
      )}
      {problem ? <FieldError>{problem}</FieldError> : null}
    </FormDialog>
  );
}
