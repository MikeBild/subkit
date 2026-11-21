import { useQuery } from "@tanstack/react-query";
import { ChatBubble } from "@ui/components/proto/ChatBubble";
import { ErrorNotice } from "@ui/components/proto/ErrorNotice";
import { EmptyState } from "@ui/components/proto/visual";
import {
  History,
  Info,
  type LucideIcon,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Send,
  X,
} from "lucide-react";
import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { apiCall } from "@/api/call";
import type { ConversationsAboutTarget } from "@/api/client";
import { ConversationsAbout } from "@/components/cockpit/conversations-about";
import { IconButton } from "@/components/cockpit/icon-button";
import {
  Button,
  DataState,
  SIDE_DETAILS_TARGET,
  SideDetailsContext,
  Timeline,
  type TimelineGroup,
  type TimelineItem,
  useErrorNotice,
} from "@/components/cockpit/patterns";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { auditActionLabel } from "@/lib/audit-model";
import type { TranslationKey } from "@/lib/i18n";
import { formatDate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { readStartLayout, startPanelOpen } from "@/lib/start-layout";
import { cn } from "@/lib/utils";
import { absolute, auditHref, conversationHref } from "./links";
import { navigationItem } from "./navigation";
import { useSession } from "./session";
import { useSidePanelChat } from "./side-panel-chat";
import {
  isSidePanelShortcut,
  keyedSidePanelWidth,
  parseSidePanelState,
  resizedSidePanelWidth,
  SIDE_PANEL_DEFAULT,
  SIDE_PANEL_MAX,
  SIDE_PANEL_MIN,
  SIDE_PANEL_SHEET_BELOW,
  SIDE_PANEL_STORAGE_KEY,
  type SidePanelState,
  type SidePanelSubject,
  type SidePanelTab,
  serializeSidePanelState,
  shownSidePanelTab,
  sidePanelContextName,
  sidePanelSubject,
  sidePanelTabs,
} from "./side-panel-model";

interface SidePanelValue {
  state: SidePanelState;
  sheet: boolean;
  sheetOpen: boolean;
  open: boolean;
  details: HTMLElement | null;
  setDetails(node: HTMLElement | null): void;
  pageTitle: string | null;
  toggle(): void;
  entered: RefObject<boolean>;
  close(): void;
  showDetails(): void;
  update(patch: Partial<SidePanelState>): void;
}

const SidePanelContext = createContext<SidePanelValue | null>(null);

function readStored(): SidePanelState {
  let stored: SidePanelState;
  try {
    stored = parseSidePanelState(window.localStorage.getItem(SIDE_PANEL_STORAGE_KEY));
  } catch {
    stored = parseSidePanelState(null);
  }
  return { ...stored, open: startPanelOpen(stored.open, readStartLayout()) };
}

function writeStored(state: SidePanelState): void {
  try {
    window.localStorage.setItem(SIDE_PANEL_STORAGE_KEY, serializeSidePanelState(state));
  } catch {
    return;
  }
}

const NARROW_QUERY = `(width < ${SIDE_PANEL_SHEET_BELOW}px)`;

function narrowList(): MediaQueryList | null {
  return typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia(NARROW_QUERY);
}

function subscribeNarrow(onChange: () => void): () => void {
  const list = narrowList();
  if (!list) return () => {};
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => narrowList()?.matches ?? false,
    () => false,
  );
}

function focusSidePanelToggle(): void {
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>('[data-testid="side-panel-toggle"]')
      ?.focus({ preventScroll: true });
  });
}

export function SidePanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SidePanelState>(readStored);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [details, setDetails] = useState<HTMLElement | null>(null);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const sheet = useNarrow();
  const update = useCallback((patch: Partial<SidePanelState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      writeStored(next);
      return next;
    });
  }, []);
  const entered = useRef(false);
  const toggle = useCallback(() => {
    if (sheet) setSheetOpen((current) => !current);
    else
      setState((current) => {
        const next = { ...current, open: !current.open };
        entered.current = next.open;
        if (!next.open) focusSidePanelToggle();
        writeStored(next);
        return next;
      });
  }, [sheet]);
  const close = useCallback(() => {
    if (sheet) setSheetOpen(false);
    else {
      update({ open: false });
      focusSidePanelToggle();
    }
  }, [sheet, update]);
  const showDetails = useCallback(() => {
    if (sheet) setSheetOpen(true);
    update(sheet ? { tab: "details" } : { open: true, tab: "details" });
  }, [sheet, update]);
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!isSidePanelShortcut(event)) return;
      event.preventDefault();
      toggleRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const open = sheet ? sheetOpen : state.open;
  const value = useMemo(
    () => ({
      state,
      sheet,
      sheetOpen,
      open,
      details,
      setDetails,
      pageTitle,
      toggle,
      close,
      showDetails,
      update,
      entered,
    }),
    [state, sheet, sheetOpen, open, details, pageTitle, toggle, close, showDetails, update],
  );
  const side = useMemo(() => ({ target: details, reportTitle: setPageTitle }), [details]);
  return (
    <SidePanelContext.Provider value={value}>
      <SideDetailsContext.Provider value={side}>{children}</SideDetailsContext.Provider>
    </SidePanelContext.Provider>
  );
}

export function SidePanelToggle({ className }: { className?: string }) {
  const panel = useContext(SidePanelContext);
  const { t } = useI18n();
  if (!panel) return null;
  const label = t(panel.open ? "sidePanel.close" : "sidePanel.open");
  return (
    <IconButton
      label={label}
      size="icon"
      tooltip={`${label} (⌘J)`}
      className={className}
      aria-expanded={panel.open}
      aria-keyshortcuts="Meta+J Control+J"
      data-testid="side-panel-toggle"
      onClick={panel.toggle}
    >
      {panel.open ? <PanelRightClose /> : <PanelRightOpen />}
    </IconButton>
  );
}

export function useSidePanelAvailable(): boolean {
  return useContext(SidePanelContext) !== null;
}

export function useShowSideDetails(): (() => void) | null {
  return useContext(SidePanelContext)?.showDetails ?? null;
}

const TAB_ICON: Record<SidePanelTab, LucideIcon> = {
  chat: MessageSquare,
  details: Info,
  history: History,
};

const TAB_LABEL: Record<SidePanelTab, TranslationKey> = {
  chat: "sidePanel.tab.chat",
  details: "sidePanel.tab.details",
  history: "sidePanel.tab.history",
};

function subjectTarget(subject: SidePanelSubject | null): ConversationsAboutTarget | null {
  if (subject?.type === "workflow") return { workflow_id: subject.id };
  if (subject?.type === "connector") return { connector_id: subject.id };
  if (subject?.type === "skill") return { skill_id: subject.id };
  if (subject?.type === "knowledge_source") return { knowledge_source_id: subject.id };
  return null;
}

function PanelChat({
  subject,
  context,
}: {
  subject: SidePanelSubject | null;
  context: string | null;
}) {
  const { t } = useI18n();
  const { permissions } = useSession();
  const [text, setText] = useState("");
  const chat = useSidePanelChat(subject, context);
  const chatFailure = useErrorNotice({
    error: chat.error,
    body: t("sidePanel.chat.failedBody"),
  });
  const target = subjectTarget(subject);
  const canAsk = permissions.includes("conversation:write");
  const end = useRef<HTMLDivElement>(null);
  const lastLine = chat.lines[chat.lines.length - 1]?.text;
  useEffect(() => {
    if (lastLine) end.current?.scrollIntoView({ block: "end" });
  }, [lastLine]);
  function submit(): void {
    if (!text.trim() || chat.sending) return;
    chat.send(text, () => setText(""));
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="side-panel-chat">
      <div
        className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4"
        aria-live="polite"
      >
        <p
          className="rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground"
          data-testid="side-panel-chat-context"
        >
          {context ? t("sidePanel.chat.seeing", { name: context }) : t("sidePanel.chat.general")}
        </p>
        {chat.lines.length > 0 ? (
          <div className="flex flex-col" data-testid="side-panel-chat-transcript">
            {chat.lines.map((line, index) => (
              <ChatBubble
                key={line.id}
                answer={line.author === "user"}
                continued={chat.lines[index - 1]?.author === line.author}
                className="max-w-[85%] whitespace-pre-wrap [overflow-wrap:anywhere]"
              >
                {line.text}
              </ChatBubble>
            ))}
            {chat.sending && !chat.lines.some((line) => line.streaming) ? (
              <p
                className="mt-3 text-xs text-muted-foreground"
                role="status"
                data-testid="side-panel-chat-thinking"
              >
                {t("sidePanel.chat.thinking")}
              </p>
            ) : null}
          </div>
        ) : canAsk ? (
          <p className="text-sm text-muted-foreground">{t("sidePanel.chat.empty")}</p>
        ) : null}
        {chat.error ? (
          <ErrorNotice
            {...chatFailure}
            title={t("sidePanel.chat.failed")}
            testId="side-panel-chat-error"
          />
        ) : null}
        {chat.waiting ? (
          <p className="text-sm" data-testid="side-panel-chat-waiting">
            {t("sidePanel.chat.waiting")}
          </p>
        ) : null}
        {chat.conversationId ? (
          <Button variant="outline" asChild>
            <a
              href={absolute(conversationHref(chat.conversationId))}
              data-testid="side-panel-chat-continue"
            >
              {t("sidePanel.chat.continue")}
            </a>
          </Button>
        ) : target ? (
          <ConversationsAbout target={target} />
        ) : null}
        <div ref={end} />
      </div>
      {canAsk ? (
        <form
          className="flex shrink-0 items-end gap-2 border-t p-3"
          data-testid="side-panel-chat-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label htmlFor="side-panel-chat-input" className="sr-only">
            {t("sidePanel.chat.inputLabel")}
          </label>
          <Textarea
            id="side-panel-chat-input"
            rows={1}
            value={text}
            readOnly={chat.sending}
            placeholder={t("sidePanel.chat.placeholder")}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            className="min-h-10 resize-none"
            data-testid="side-panel-chat-input"
          />
          <IconButton
            type="submit"
            variant="default"
            size="icon"
            label={t("sidePanel.chat.send")}
            disabled={!text.trim() || chat.sending}
            data-testid="side-panel-chat-send"
          >
            <Send />
          </IconButton>
        </form>
      ) : null}
    </div>
  );
}

function historyQuery(subject: SidePanelSubject): Record<string, string | number> {
  if (subject.type === "task") return { task_id: subject.id, limit: 30 };
  return { resource_type: subject.type, resource_id: subject.id, limit: 30 };
}

function PanelHistory({ subject }: { subject: SidePanelSubject | null }) {
  const { t, locale } = useI18n();
  const { permissions } = useSession();
  const allowed = permissions.includes("audit:read");
  const query = useQuery({
    queryKey: ["side-panel", "history", subject?.type, subject?.id],
    queryFn: () =>
      apiCall("get", "/v1/audit-log", {
        query: historyQuery(subject as SidePanelSubject),
      }),
    enabled: allowed && subject !== null,
  });
  if (!subject || !allowed)
    return (
      <EmptyState
        icon={History}
        title={t("sidePanel.history.none")}
        text={t(allowed ? "sidePanel.history.noneText" : "sidePanel.history.forbidden")}
        testId="side-panel-history-empty"
      />
    );
  if (query.isPending) return <DataState state="loading" testId="side-panel-history-loading" />;
  if (query.error)
    return (
      <DataState
        state="error"
        line={t("sidePanel.history.failed")}
        onRetry={() => void query.refetch()}
        testId="side-panel-history-error"
      />
    );
  const entries = query.data?.items ?? [];
  if (entries.length === 0)
    return (
      <EmptyState
        icon={History}
        title={t("sidePanel.history.none")}
        text={t("sidePanel.history.noneText")}
        testId="side-panel-history-empty"
      />
    );
  const groups: TimelineGroup[] = [];
  const byDay = new Map<string, TimelineItem[]>();
  for (const entry of entries) {
    const day = formatDate(locale, entry.ts);
    const label = auditActionLabel(entry.action);
    const items = byDay.get(day) ?? [];
    if (!byDay.has(day)) {
      byDay.set(day, items);
      groups.push({ label: day, items });
    }
    items.push({
      id: entry.id,
      tone: entry.result === "success" ? "neutral" : entry.result === "denied" ? "warn" : "error",
      title: label.kind === "named" ? t(label.key) : label.value,
      time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
        new Date(entry.ts),
      ),
      dateTime: entry.ts,
    });
  }
  return (
    <div className="flex flex-col gap-4" data-testid="side-panel-history">
      <Timeline groups={groups} testId="side-panel-history-timeline" />
      <Button variant="outline" asChild>
        <a
          data-testid="side-panel-history-all"
          href={absolute(
            subject.type === "task"
              ? auditHref({ resourceType: "task", resourceId: subject.id })
              : auditHref({ resourceType: subject.type, resourceId: subject.id }),
          )}
        >
          {t("sidePanel.history.all")}
        </a>
      </Button>
    </div>
  );
}

function PanelBody({ pathname, overlay }: { pathname: string; overlay: boolean }) {
  const panel = useContext(SidePanelContext);
  const { t } = useI18n();
  const [drag, setDrag] = useState<number | null>(null);
  const frame = useRef<HTMLElement>(null);
  const entered = panel?.entered;
  useEffect(() => {
    if (!entered?.current) return;
    entered.current = false;
    frame.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.focus({ preventScroll: true });
  }, [entered]);
  if (!panel) return null;
  const tabs = sidePanelTabs(pathname);
  const tab = shownSidePanelTab(panel.state.tab, tabs);
  const subject = sidePanelSubject(pathname);
  const nav = navigationItem(pathname);
  const width = drag ?? panel.state.width;

  function startDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!panel) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel.state.width;
    let next = startWidth;
    function move(moved: PointerEvent): void {
      next = resizedSidePanelWidth(startWidth, startX, moved.clientX);
      setDrag(next);
    }
    function up(): void {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      panel?.update({ width: next });
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onResizeKey(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const next = keyedSidePanelWidth(width, event.key);
    if (next === null) return;
    event.preventDefault();
    panel?.update({ width: next });
  }

  return (
    <aside
      ref={frame}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || overlay) return;
        if (
          (event.target as HTMLElement).closest('[role="dialog"], [role="menu"], [role="listbox"]')
        )
          return;
        event.preventDefault();
        panel.close();
      }}
      aria-label={t("sidePanel.label")}
      data-slot="side-panel"
      data-testid="side-panel"
      data-side-panel-tab={tab}
      style={overlay ? undefined : { width }}
      className={cn(
        "relative flex min-h-0 shrink-0 flex-col bg-background",
        overlay ? "h-full w-full" : "border-l",
      )}
    >
      {overlay ? null : (
        // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the window splitter pattern
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("sidePanel.resize")}
          aria-valuemin={SIDE_PANEL_MIN}
          aria-valuemax={SIDE_PANEL_MAX}
          aria-valuenow={width}
          title={t("sidePanel.resize")}
          tabIndex={0}
          data-testid="side-panel-resize"
          onPointerDown={startDrag}
          onDoubleClick={() => panel.update({ width: SIDE_PANEL_DEFAULT })}
          onKeyDown={onResizeKey}
          className="group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none focus-visible:outline-none"
        >
          <span
            className={cn(
              "absolute inset-y-0 left-[3px] w-0.5 rounded-full transition-colors group-hover:bg-ring/50 group-focus-visible:bg-ring",
              drag !== null && "bg-ring",
            )}
          />
        </div>
      )}
      <div className="flex h-14 shrink-0 items-center gap-1 border-b px-3">
        <div
          role="tablist"
          aria-label={t("sidePanel.label")}
          className="flex min-w-0 flex-1 items-center gap-1"
        >
          {tabs.map((entry) => {
            const Icon = TAB_ICON[entry];
            return (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={tab === entry}
                data-testid={`side-panel-tab-${entry}`}
                onClick={() => panel.update({ tab: entry })}
                className={cn(
                  "inline-flex h-10 min-w-0 items-center gap-2 rounded-control px-3 text-sm",
                  tab === entry
                    ? "bg-secondary font-medium"
                    : "text-muted-foreground hover:bg-secondary/60",
                )}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span className="truncate">{t(TAB_LABEL[entry])}</span>
              </button>
            );
          })}
        </div>
        <IconButton
          label={t("sidePanel.close")}
          size="icon"
          data-testid="side-panel-close"
          onClick={panel.close}
        >
          <X />
        </IconButton>
      </div>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          tab !== "chat" && "scrollbar-thin overflow-y-auto p-6",
        )}
        role="tabpanel"
        aria-label={t(TAB_LABEL[tab])}
        data-slot="side-panel-body"
      >
        <div className={cn(tab !== "details" && "hidden")} data-testid="side-panel-details">
          <div ref={panel.setDetails} className={SIDE_DETAILS_TARGET} />
          <div className="hidden peer-empty:block">
            <EmptyState
              icon={Info}
              title={t("sidePanel.details.none")}
              text={t("sidePanel.details.noneText")}
              testId="side-panel-details-empty"
            />
          </div>
        </div>
        {tab === "chat" ? (
          <PanelChat
            subject={subject}
            context={sidePanelContextName({
              pageTitle: panel.pageTitle,
              navLabel: nav ? t(nav.labelKey) : null,
            })}
          />
        ) : null}
        {tab === "history" ? <PanelHistory subject={subject} /> : null}
      </div>
    </aside>
  );
}

export function SidePanel({ pathname }: { pathname: string }) {
  const panel = useContext(SidePanelContext);
  const { t } = useI18n();
  if (!panel) return null;
  if (panel.sheet)
    return (
      <Sheet open={panel.sheetOpen} onOpenChange={(open) => (open ? undefined : panel.close())}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="w-full gap-0 p-0 sm:max-w-[420px]"
          data-testid="side-panel-sheet"
        >
          <SheetTitle className="sr-only">{t("sidePanel.label")}</SheetTitle>
          <SheetDescription className="sr-only">{t("sidePanel.description")}</SheetDescription>
          <PanelBody pathname={pathname} overlay />
        </SheetContent>
      </Sheet>
    );
  return panel.state.open ? <PanelBody pathname={pathname} overlay={false} /> : null;
}
