import { useQuery } from "@tanstack/react-query";
import { History, Info, type LucideIcon, MessageSquare, PanelRight, X } from "lucide-react";
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
} from "@/components/cockpit/patterns";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { TranslationKey } from "@/lib/i18n";
import { formatDate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { auditActionLabel } from "@/pages/audit-model";
import { absolute, auditHref, chatNewHref } from "./links";
import { useSession } from "./session";
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
  toggle(): void;
  entered: RefObject<boolean>;
  close(): void;
  update(patch: Partial<SidePanelState>): void;
}

const SidePanelContext = createContext<SidePanelValue | null>(null);

function readStored(): SidePanelState {
  try {
    return parseSidePanelState(window.localStorage.getItem(SIDE_PANEL_STORAGE_KEY));
  } catch {
    return parseSidePanelState(null);
  }
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
    () => ({ state, sheet, sheetOpen, open, details, setDetails, toggle, close, update, entered }),
    [state, sheet, sheetOpen, open, details, toggle, close, update],
  );
  const side = useMemo(() => ({ target: details }), [details]);
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
      tooltip={`${label} (⌘J)`}
      className={className}
      aria-expanded={panel.open}
      aria-keyshortcuts="Meta+J Control+J"
      data-testid="side-panel-toggle"
      onClick={panel.toggle}
    >
      <PanelRight />
    </IconButton>
  );
}

export function useSidePanelAvailable(): boolean {
  return useContext(SidePanelContext) !== null;
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

function PanelEmpty({ title, text, testId }: { title: string; text: string; testId: string }) {
  return (
    <div
      className="flex flex-col gap-1 rounded-lg border border-dashed px-4 py-3"
      data-testid={testId}
    >
      <p className="text-sm font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function PanelChat({ subject }: { subject: SidePanelSubject | null }) {
  const { t } = useI18n();
  const { permissions } = useSession();
  const target =
    subject?.type === "workflow"
      ? { workflow_id: subject.id }
      : subject?.type === "connector"
        ? { connector_id: subject.id }
        : subject?.type === "skill"
          ? { skill_id: subject.id }
          : subject?.type === "knowledge_source"
            ? { knowledge_source_id: subject.id }
            : null;
  const canAsk = permissions.includes("conversation:write");
  return (
    <div className="flex flex-col gap-4" data-testid="side-panel-chat">
      <p className="rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
        {t(target ? "sidePanel.chat.context" : "sidePanel.chat.general")}
      </p>
      {target ? <ConversationsAbout target={target} /> : null}
      {canAsk ? (
        <Button variant="outline" asChild>
          <a
            data-testid="side-panel-chat-ask"
            href={absolute(
              chatNewHref(
                target
                  ? {
                      workflowId: target.workflow_id,
                      connectorId: target.connector_id,
                      references: subject
                        ? [
                            {
                              type: subject.type as
                                | "workflow"
                                | "connector"
                                | "skill"
                                | "knowledge_source",
                              id: subject.id,
                            },
                          ]
                        : [],
                    }
                  : {},
              ),
            )}
          >
            {t("catalog.conversations.ask")}
          </a>
        </Button>
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
      <PanelEmpty
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
      <PanelEmpty
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
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
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
                  "inline-flex h-8 min-w-0 items-center gap-2 rounded-md px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
          data-testid="side-panel-close"
          onClick={panel.close}
        >
          <X />
        </IconButton>
      </div>
      <div
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4"
        role="tabpanel"
        aria-label={t(TAB_LABEL[tab])}
        data-slot="side-panel-body"
      >
        <div className={cn(tab !== "details" && "hidden")} data-testid="side-panel-details">
          <div ref={panel.setDetails} className={SIDE_DETAILS_TARGET} />
          <div className="hidden peer-empty:block">
            <PanelEmpty
              title={t("sidePanel.details.none")}
              text={t("sidePanel.details.noneText")}
              testId="side-panel-details-empty"
            />
          </div>
        </div>
        {tab === "chat" ? <PanelChat subject={subject} /> : null}
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
