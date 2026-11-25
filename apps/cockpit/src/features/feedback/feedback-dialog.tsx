import { classifyOutcome, type OfflineIdentity } from "@shared/offline-queue.ts";
import { useQueryClient } from "@tanstack/react-query";
import { useUi } from "@ui/lib/ui-context";
import { ErrorNotice, FieldError } from "@ui/molecules/error-notice";
import { IconButton } from "@ui/molecules/icon-button";
import { ChevronDown, Paperclip, Send, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { submitFeedback } from "@/api/feedback";
import { connectivity } from "@/app/connectivity";
import { useLiveStatus } from "@/app/live-events";
import { useSession } from "@/app/session";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  FactList,
  Textarea,
} from "@/components/cockpit/patterns";
import {
  type AttachmentProblem,
  attachmentProblem,
  base64OfDataUrl,
  buildFeedbackBody,
  buildFeedbackDiagnostics,
  clientKindOf,
  desktopFacts,
  diagnosticsAttachment,
  FEEDBACK_ACCEPT,
  FEEDBACK_KINDS,
  FEEDBACK_MAX_MESSAGE,
  FEEDBACK_SEARCH_PARAM,
  type FeedbackDiagnostics,
  type FeedbackFile,
  type FeedbackKind,
  feedbackFailure,
  feedbackResponse,
  hasFeedbackDraft,
  needsUncleanedWarning,
  screenshotHint,
} from "@/features/feedback/model/feedback";
import { runsInstalled } from "@/features/pwa";
import { errorRows } from "@/lib/error-rows";
import { useI18n } from "@/lib/i18n-context";
import { writeSearchParam } from "@/lib/use-search-param-state";
import { feedbackBridge, within } from "./desktop-bridge";
import type { FailedReport } from "./failed-model";
import { FailedReports } from "./failed-reports";
import { feedbackQueue } from "./queue";
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

function useDiagnostics(route: string): () => Promise<FeedbackDiagnostics> {
  const session = useSession();
  const { status, serverVersion } = useLiveStatus();
  const { t } = useI18n();
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
      errors: [...(facts?.errors ?? []), ...feedbackStore().errors(), ...connectivity.log()],
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

function FeedbackDialog({
  identity,
  waiting,
  unsent,
  route,
}: {
  identity: OfflineIdentity;
  waiting: number;
  unsent: UnsentReports;
  route: string;
}) {
  const { t, tn } = useI18n();
  const { now } = useUi();
  const store = feedbackStore();
  const { open, draft, status, failure, requestId } = useFeedbackState();
  const collect = useDiagnostics(route);
  const [preview, setPreview] = useState(false);
  const [lastError, setLastError] = useState<unknown>(null);
  const [problem, setProblem] = useState<FileProblem | null>(null);
  const [diagnostics, setDiagnostics] = useState<FeedbackDiagnostics | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const checkboxId = useId();
  const sending = status === "sending";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      const next = await collect();
      if (!cancelled) setDiagnostics(next);
    };
    void load();
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
    const done = (message: string, reference?: string) => {
      store.discard();
      setProblem(null);
      setPreview(false);
      toast.success(
        message,
        reference ? { description: t("feedback.reference", { id: reference }) } : undefined,
      );
    };
    let body: ReturnType<typeof buildFeedbackBody> | null = null;
    try {
      const current = draft.diagnostics ? await collect() : null;
      const link = connectivity.get();
      body = buildFeedbackBody({
        requestId,
        draft,
        diagnostics: current,
        diagnosticsFile: current
          ? diagnosticsAttachment(current, { traceId: link.traceId, connectionCause: link.cause })
          : null,
        createdAt: new Date(now()).toISOString(),
      });
      const submitted = await submitFeedback(body);
      done(t("feedback.thanks"), submitted.id);
    } catch (error) {
      const transient = classifyOutcome(feedbackResponse(error)).kind === "retry";
      if (body && transient && (await feedbackQueue().add(identity, requestId, body))) {
        done(t("feedback.queued"));
        return;
      }
      setLastError(error);
      store.failed(feedbackFailure(error));
    }
  }

  const screenshotShown = draft.screenshot !== null && draft.screenshotIncluded;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) store.close();
      }}
    >
      <DialogContent
        closeLabel={t("common.close")}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-[720px]"
        data-testid="feedback"
      >
        <div className="flex flex-col gap-2">
          <DialogTitle>{t("feedback.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("feedback.notice")}</DialogDescription>
        </div>
        <fieldset
          className="flex min-w-0 gap-1 border-0 p-0"
          aria-label={t("feedback.kind")}
          data-testid="feedback-kind"
        >
          {FEEDBACK_KINDS.map((kind) => (
            <Button
              key={kind}
              type="button"
              size="sm"
              variant={kind === draft.kind ? "secondary" : "ghost"}
              aria-pressed={kind === draft.kind}
              disabled={sending}
              onClick={() => store.update({ kind: kind as FeedbackKind })}
              data-testid={`feedback-kind-${kind}`}
            >
              {t(`feedback.kind.${kind}`)}
            </Button>
          ))}
        </fieldset>
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
            <Paperclip className="size-4" aria-hidden="true" />
            {t("feedback.attach")}
          </Button>
          {draft.files.map((file, index) => (
            <span
              key={file.id}
              className="inline-flex max-w-full items-center gap-1 rounded-md border px-2 text-xs"
              data-testid={`feedback-file-${index}`}
            >
              <span className="truncate">{file.name}</span>
              <IconButton
                type="button"
                size="icon-xs"
                disabled={sending}
                label={t("feedback.remove", { name: file.name })}
                onClick={() =>
                  store.update({ files: draft.files.filter((item) => item.id !== file.id) })
                }
                data-testid={`feedback-file-remove-${index}`}
              >
                <X className="size-3" />
              </IconButton>
            </span>
          ))}
          {screenshotShown ? (
            <span
              className="inline-flex items-center gap-1 rounded-md border px-2 text-xs"
              title={t(`feedback.screenshot.hint.${screenshotHint(store.screenshotCapability())}`)}
              data-testid="feedback-screenshot-block"
            >
              {t("feedback.screenshot")}
              <IconButton
                type="button"
                size="icon-xs"
                disabled={sending}
                label={t("feedback.remove", { name: t("feedback.screenshot") })}
                onClick={() => store.update({ screenshotIncluded: false })}
                data-testid="feedback-screenshot"
              >
                <X className="size-3" />
              </IconButton>
            </span>
          ) : null}
        </div>
        {problem ? (
          <FieldError testId="feedback-attach-error">{t(`feedback.problem.${problem}`)}</FieldError>
        ) : null}
        {needsUncleanedWarning(draft.files) ? (
          <p className="text-xs text-muted-foreground" data-testid="feedback-attach-uncleaned">
            {t("feedback.attachUncleaned")}
          </p>
        ) : null}
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Checkbox
              id={checkboxId}
              checked={draft.diagnostics}
              disabled={sending}
              onCheckedChange={(checked) => store.update({ diagnostics: checked === true })}
              data-testid="feedback-diagnostics"
            />
            <label htmlFor={checkboxId} className="text-sm">
              {t("feedback.diagnostics")}
            </label>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={preview}
              onClick={() => setPreview(!preview)}
              data-testid="feedback-diagnostics-view"
            >
              {t("feedback.view")}
              <ChevronDown className="size-3" aria-hidden="true" />
            </Button>
          </div>
          {preview ? <DiagnosticsPreview diagnostics={diagnostics} /> : null}
          <p className="mt-2 text-xs text-muted-foreground" data-testid="feedback-redact">
            {t("feedback.redact")}
          </p>
        </div>
        <p
          className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
          data-testid="feedback-notice"
        >
          {t("feedback.notice")}
        </p>
        {waiting > 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="feedback-waiting">
            {tn("feedback.waiting", waiting)}
          </p>
        ) : null}
        <FailedReports
          reports={unsent.reports}
          busy={unsent.busy}
          onResend={unsent.resend}
          onDiscard={unsent.discard}
        />
        {status === "failed" ? (
          <ErrorNotice
            testId="feedback-failed"
            kind="feedbackFailed"
            title={t("feedback.failed.title")}
            body={t(`feedback.failed.${failure ?? "generic"}`)}
            primary={{ label: t("pattern.retry"), onClick: () => void send() }}
            rows={errorRows(lastError, t)}
          />
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {hasFeedbackDraft(draft) ? (
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
          ) : null}
          <Button
            type="button"
            disabled={!draft.text.trim() || sending}
            onClick={() => void send()}
            data-testid="feedback-submit"
          >
            <Send className="size-4" aria-hidden="true" />
            {sending
              ? t("feedback.sending")
              : status === "failed"
                ? t("pattern.retry")
                : t("feedback.send")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface UnsentReports {
  reports: readonly FailedReport[];
  busy: boolean;
  resend(id: string): void;
  discard(id: string): void;
}

function useQueuedFeedback(): {
  identity: OfflineIdentity;
  waiting: number;
  unsent: UnsentReports;
} {
  const session = useSession();
  const user_id = session.principal.id;
  const identity = useMemo(() => ({ server: window.location.origin, user_id }), [user_id]);
  const [waiting, setWaiting] = useState(0);
  const [reports, setReports] = useState<readonly FailedReport[]>([]);
  const [busy, setBusy] = useState(false);
  const unsent = useMemo<UnsentReports>(() => {
    const settle = async (work: Promise<void>) => {
      setBusy(true);
      try {
        await work;
      } finally {
        setBusy(false);
      }
    };
    return {
      reports,
      busy,
      resend: (id) => void settle(feedbackQueue().resend(identity, id, crypto.randomUUID())),
      discard: (id) => void settle(feedbackQueue().discard(identity, id)),
    };
  }, [identity, reports, busy]);
  useEffect(() => {
    const queue = feedbackQueue();
    let live = true;
    const refresh = () => {
      const loadWaiting = async () => {
        const count = await queue.waiting(identity);
        if (live) setWaiting(count);
      };
      const loadFailed = async () => {
        const next = await queue.failed(identity);
        if (live) setReports(next);
      };
      void loadWaiting();
      void loadFailed();
    };
    const flush = () => void queue.flush(identity);
    const off = queue.subscribe(refresh);
    const start = async () => {
      await queue.signedIn(identity);
      flush();
    };
    void start();
    refresh();
    window.addEventListener("online", flush);
    window.addEventListener("focus", flush);
    return () => {
      live = false;
      off();
      window.removeEventListener("online", flush);
      window.removeEventListener("focus", flush);
    };
  }, [identity]);
  return { identity, waiting, unsent };
}

export function FeedbackHost({ pathname, search }: { pathname: string; search: string }) {
  const client = useQueryClient();
  const queued = useQueuedFeedback();

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

  return (
    <FeedbackDialog
      identity={queued.identity}
      waiting={queued.waiting}
      unsent={queued.unsent}
      route={pathname}
    />
  );
}
