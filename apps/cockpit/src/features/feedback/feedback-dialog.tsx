import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { ChevronDown, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { submitFeedback } from "@/api/feedback";
import { useLiveStatus } from "@/app/live-events";
import { useSession } from "@/app/session";
import { IconButton } from "@/components/cockpit/icon-button";
import {
  Button,
  Checkbox,
  Chip,
  FactList,
  FormDialog,
  Label,
  SegmentedControl,
  Textarea,
} from "@/components/cockpit/patterns";
import { LoadFailed } from "@/components/failure-state";
import { runsInstalled } from "@/features/pwa/display-mode";
import { useI18n } from "@/lib/i18n-context";
import { writeSearchParam } from "@/lib/use-search-param-state";
import { feedbackBridge, within } from "./desktop-bridge";
import {
  type AttachmentProblem,
  attachmentProblem,
  base64OfDataUrl,
  buildFeedbackBody,
  buildFeedbackDiagnostics,
  clientKindOf,
  desktopFacts,
  FEEDBACK_ACCEPT,
  FEEDBACK_KINDS,
  FEEDBACK_MAX_MESSAGE,
  FEEDBACK_SEARCH_PARAM,
  type FeedbackDiagnostics,
  type FeedbackFile,
  type FeedbackKind,
  feedbackFailure,
  hasFeedbackDraft,
  screenshotHint,
} from "./model";
import { feedbackStore, openFeedback, useFeedbackState } from "./store";

const DIAGNOSTICS_TIMEOUT_MS = 3000;

type FileProblem = AttachmentProblem | "read";

function browserPlatform(): string | null {
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  return data?.platform || navigator.platform || null;
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(base64OfDataUrl(String(reader.result)));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function useDiagnostics(): () => Promise<FeedbackDiagnostics> {
  const session = useSession();
  const { status, serverVersion } = useLiveStatus();
  const { t } = useI18n();
  const route = useRouterState({ select: (state) => state.location.pathname });
  const removed = t("feedback.removed");
  return useCallback(async () => {
    const bridge = feedbackBridge();
    const facts = bridge
      ? desktopFacts(await within(bridge.diagnostics(), DIAGNOSTICS_TIMEOUT_MS, null))
      : null;
    return buildFeedbackDiagnostics({
      clientKind: clientKindOf({
        desktop: bridge !== null,
        standalone: runsInstalled(),
      }),
      appVersion: facts?.appVersion ?? session.version,
      platform: facts?.platform ?? browserPlatform(),
      serverVersion: serverVersion ?? session.version,
      connection: status,
      route,
      errors: [...(facts?.errors ?? []), ...feedbackStore().errors()],
      removed,
    });
  }, [session.version, serverVersion, status, route, removed]);
}

function DiagnosticsPreview({ diagnostics }: { diagnostics: FeedbackDiagnostics | null }) {
  const { t } = useI18n();
  if (!diagnostics) return null;
  const errors = diagnostics.recent_errors ?? [];
  const facts = [
    {
      label: t("feedback.diag.client"),
      value: t(`feedback.diag.client.${diagnostics.client_kind ?? "browser"}`),
    },
    { label: t("feedback.diag.appVersion"), value: diagnostics.app_version },
    { label: t("feedback.diag.platform"), value: diagnostics.platform },
    { label: t("feedback.diag.serverVersion"), value: diagnostics.server_version },
    { label: t("feedback.diag.connection"), value: diagnostics.connection },
    { label: t("feedback.diag.route"), value: diagnostics.route },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));
  return (
    <div
      className="flex flex-col gap-3 rounded-md border bg-secondary p-3 text-xs"
      data-testid="feedback-diagnostics-preview"
    >
      <FactList items={facts} testId="feedback-diagnostics-facts" />
      <div className="flex flex-col gap-1">
        <p className="font-semibold">{t("feedback.diag.errors")}</p>
        {errors.length > 0 ? (
          <ul className="flex flex-col gap-0.5 font-mono">
            {errors.map((entry) => (
              <li key={`${entry.at}-${entry.code}`} className="break-all">
                {entry.at} {entry.code}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{t("feedback.diag.noErrors")}</p>
        )}
      </div>
    </div>
  );
}

function FeedbackDialog() {
  const { t } = useI18n();
  const store = feedbackStore();
  const { open, draft, status, failure, requestId } = useFeedbackState();
  const collect = useDiagnostics();
  const [preview, setPreview] = useState(false);
  const [problem, setProblem] = useState<FileProblem | null>(null);
  const [diagnostics, setDiagnostics] = useState<FeedbackDiagnostics | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const checkboxId = useId();
  const screenshotId = useId();
  const sending = status === "sending";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void collect().then((next) => {
      if (!cancelled) setDiagnostics(next);
    });
    return () => {
      cancelled = true;
    };
  }, [open, collect]);

  async function addFiles(list: FileList | null): Promise<void> {
    if (!list) return;
    const additions: FeedbackFile[] = [];
    let found: FileProblem | null = null;
    for (const file of Array.from(list)) {
      const refused = attachmentProblem(draft.files.length + additions.length, file);
      if (refused) {
        found = refused;
        continue;
      }
      try {
        additions.push({
          id: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          content_base64: await readFile(file),
        });
      } catch {
        found = "read";
      }
    }
    if (additions.length > 0) store.update({ files: [...draft.files, ...additions] });
    setProblem(found);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function send(): Promise<void> {
    if (sending || !draft.text.trim()) return;
    store.sending();
    try {
      const current = draft.diagnostics ? await collect() : null;
      await submitFeedback(buildFeedbackBody({ requestId, draft, diagnostics: current }));
      store.discard();
      setProblem(null);
      setPreview(false);
      toast.success(t("feedback.thanks"));
    } catch (error) {
      store.failed(feedbackFailure(error));
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) store.close();
      }}
      title={t("feedback.title")}
      size="wide"
      testId="feedback"
      cancel={false}
      actions={
        hasFeedbackDraft(draft) ? (
          <Button
            type="button"
            variant="ghost"
            disabled={sending}
            onClick={() => {
              store.discard();
              setProblem(null);
            }}
            data-testid="feedback-discard"
          >
            {t("feedback.discard")}
          </Button>
        ) : null
      }
      submit={{
        label: sending ? t("feedback.sending") : t("feedback.send"),
        pending: sending,
        disabled: !draft.text.trim(),
      }}
      onSubmit={send}
    >
      <SegmentedControl
        label={t("feedback.kind")}
        testId="feedback-kind"
        disabled={sending}
        value={draft.kind}
        onValueChange={(kind) => store.update({ kind: kind as FeedbackKind })}
        options={FEEDBACK_KINDS.map((kind) => ({
          value: kind,
          label: t(`feedback.kind.${kind}`),
          testId: `feedback-kind-${kind}`,
        }))}
      />
      <Textarea
        className="min-h-36"
        aria-label={t(`feedback.placeholder.${draft.kind}`)}
        placeholder={t(`feedback.placeholder.${draft.kind}`)}
        value={draft.text}
        maxLength={FEEDBACK_MAX_MESSAGE}
        disabled={sending}
        onChange={(event) => store.update({ text: event.target.value })}
        data-testid="feedback-message"
      />
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept={FEEDBACK_ACCEPT}
            multiple
            hidden
            aria-label={t("feedback.attach")}
            onChange={(event) => void addFiles(event.target.files)}
            data-testid="feedback-file-input"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={sending}
            title={t("feedback.attachHint")}
            onClick={() => fileInput.current?.click()}
            data-testid="feedback-attach"
          >
            <Paperclip aria-hidden="true" />
            {t("feedback.attach")}
          </Button>
          {draft.files.map((file, index) => (
            <Chip key={file.id} className="min-w-0 shrink" testId={`feedback-file-${index}`}>
              <span className="truncate">{file.name}</span>
              <IconButton
                type="button"
                size="icon-xs"
                label={t("feedback.remove", { name: file.name })}
                disabled={sending}
                onClick={() =>
                  store.update({ files: draft.files.filter((item) => item.id !== file.id) })
                }
                data-testid={`feedback-file-remove-${index}`}
              >
                <X />
              </IconButton>
            </Chip>
          ))}
        </div>
        <p className="text-xs text-muted-foreground" data-testid="feedback-attach-uncleaned">
          {t("feedback.attachUncleaned")}
        </p>
        {problem ? (
          <p role="alert" className="text-sm text-destructive" data-testid="feedback-attach-error">
            {t(`feedback.problem.${problem}`)}
          </p>
        ) : null}
      </div>
      {draft.screenshot ? (
        <div className="flex flex-col gap-2" data-testid="feedback-screenshot-block">
          <div className="flex flex-wrap items-center gap-2">
            <Checkbox
              id={screenshotId}
              checked={draft.screenshotIncluded}
              disabled={sending}
              onCheckedChange={(checked) => store.update({ screenshotIncluded: checked === true })}
              data-testid="feedback-screenshot"
            />
            <Label htmlFor={screenshotId} className="text-sm font-normal">
              {t("feedback.screenshot.attach")}
            </Label>
          </div>
          <img
            src={`data:image/png;base64,${draft.screenshot}`}
            alt={t("feedback.screenshot")}
            className="max-h-40 w-fit rounded-md border"
            data-testid="feedback-screenshot-preview"
          />
          <p className="text-xs text-muted-foreground" data-testid="feedback-screenshot-hint">
            {t(`feedback.screenshot.hint.${screenshotHint(store.screenshotCapability())}`)}
          </p>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Checkbox
            id={checkboxId}
            checked={draft.diagnostics}
            disabled={sending}
            onCheckedChange={(checked) => store.update({ diagnostics: checked === true })}
            data-testid="feedback-diagnostics"
          />
          <Label htmlFor={checkboxId} className="text-sm font-normal">
            {t("feedback.diagnostics")}
          </Label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-expanded={preview}
            onClick={() => setPreview(!preview)}
            data-testid="feedback-diagnostics-view"
          >
            {t("feedback.view")}
            <ChevronDown aria-hidden="true" className={preview ? "rotate-180" : undefined} />
          </Button>
        </div>
        {preview ? <DiagnosticsPreview diagnostics={diagnostics} /> : null}
        <p className="text-xs text-muted-foreground" data-testid="feedback-redact">
          {t("feedback.redact")}
        </p>
      </div>
      <p
        className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
        data-testid="feedback-notice"
      >
        {t("feedback.notice")}
      </p>
      {status === "failed" ? (
        <LoadFailed
          title={t("feedback.failed.title")}
          description={t(`feedback.failed.${failure ?? "generic"}`)}
          onRetry={() => void send()}
          testId="feedback-failed"
        />
      ) : null}
    </FormDialog>
  );
}

export function FeedbackHost() {
  const client = useQueryClient();
  const search = useRouterState({ select: (state) => state.location.searchStr });

  useEffect(() => {
    const store = feedbackStore();
    const note = (error: unknown) => store.recordError(error, new Date());
    const queries = client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") note(event.action.error);
    });
    const mutations = client.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") note(event.action.error);
    });
    const onError = (event: ErrorEvent) => note(event.error ?? { name: "Error" });
    const onRejection = (event: PromiseRejectionEvent) => note(event.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      queries();
      mutations();
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [client]);

  useEffect(() => {
    const asked = [search, window.location.search].some(
      (query) => new URLSearchParams(query).get(FEEDBACK_SEARCH_PARAM) === "1",
    );
    if (!asked) return;
    writeSearchParam(FEEDBACK_SEARCH_PARAM, null, "");
    openFeedback();
  }, [search]);

  useEffect(() => feedbackStore().onRequested(() => openFeedback()), []);

  return <FeedbackDialog />;
}
