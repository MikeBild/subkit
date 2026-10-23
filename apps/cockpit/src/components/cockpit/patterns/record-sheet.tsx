import { ChevronLeft, XIcon } from "lucide-react";
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "@/components/cockpit/icon-button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useI18n } from "@/lib/i18n-context";
import { useInspectorDock } from "./responsive-workspace";
import { Loadable, RowsSkeleton, Skeleton } from "./skeleton";

export type SheetSize = "default" | "wide";

export function sheetWidthClass(size: SheetSize): string {
  return size === "wide" ? "data-[side=right]:sm:max-w-5xl" : "data-[side=right]:sm:max-w-xl";
}

function SheetBodySkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-6 gap-y-2">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="contents">
            <span className="flex h-5 items-center">
              <Skeleton className="h-3.5 w-24" />
            </span>
            <span className="flex h-5 items-center">
              <Skeleton className={index % 2 ? "h-3.5 w-1/3" : "h-3.5 w-1/2"} />
            </span>
          </div>
        ))}
      </div>
      <RowsSkeleton count={3} />
    </div>
  );
}

export interface RecordSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  size?: SheetSize;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  back?: { label: string; onClick(): void };
  action?: ReactNode;
  menu?: ReactNode;
  testId: string;
  closeTestId?: string;
  titleTestId?: string;
  loading?: boolean;
  children: ReactNode;
  dock?: boolean;
}

function RecordBody({
  title,
  subtitle,
  badge,
  back,
  action,
  menu,
  testId,
  titleTestId,
  loading,
  children,
  titleId,
}: RecordSheetProps & { titleId?: string }) {
  return (
    <>
      <SheetHeader className="gap-1 pr-14">
        {back ? (
          <button
            type="button"
            onClick={back.onClick}
            data-slot="sheet-back"
            data-testid={`${testId}-back`}
            className="inline-flex w-fit items-center gap-0.5 rounded-sm text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            <ChevronLeft aria-hidden="true" className="-ml-1 size-4" />
            {back.label}
          </button>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <div className="flex min-w-0 flex-[1_1_14rem] flex-wrap items-center gap-2">
            <SheetTitle
              {...(titleId ? { id: titleId } : {})}
              data-testid={titleTestId}
              className="flex min-w-0 flex-[1_1_10rem] items-center gap-2 break-words"
            >
              {title}
            </SheetTitle>
            {badge}
          </div>
          {action || menu ? (
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {menu}
              {action}
            </span>
          ) : null}
        </div>
        {subtitle ? (
          <div className="text-sm text-muted-foreground" data-testid={`${testId}-subtitle`}>
            {subtitle}
          </div>
        ) : null}
      </SheetHeader>
      <Loadable
        loading={loading}
        skeleton={<SheetBodySkeleton />}
        className="flex flex-col gap-6 p-4 pt-0"
      >
        {children}
      </Loadable>
    </>
  );
}

function DockableRecordSheet(props: RecordSheetProps) {
  const { open, onOpenChange, size = "default", testId, closeTestId } = props;
  const { t } = useI18n();
  const titleId = useId();
  const { docked, host: dockHost } = useInspectorDock(open, size);
  const [host, setHost] = useState<HTMLDivElement | null>(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );
  const [modalHost, setModalHost] = useState<HTMLDivElement | null>(null);
  const previousOpen = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const focused = useRef<HTMLElement | null>(null);
  const dockedRef = useRef(docked);
  dockedRef.current = docked;
  useLayoutEffect(() => {
    if (!host) setHost(document.createElement("div"));
  }, [host]);
  useLayoutEffect(
    () => () => {
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    },
    [],
  );
  useLayoutEffect(() => {
    if (!docked || !host) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]'))
        return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    };
    host.addEventListener("keydown", dismiss);
    return () => host.removeEventListener("keydown", dismiss);
  }, [docked, host, onOpenChange]);
  useLayoutEffect(() => {
    if (open && !previousOpen.current)
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!open && previousOpen.current && opener.current?.isConnected)
      opener.current.focus({ preventScroll: true });
    previousOpen.current = open;
  }, [open]);
  useLayoutEffect(() => {
    if (!host || !open) return;
    const target = docked ? dockHost : modalHost;
    if (!target) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && host.contains(active)) focused.current = active;
    target.appendChild(host);
    host.className =
      "relative flex h-full min-h-0 min-w-0 flex-col gap-4 overflow-y-auto bg-popover text-sm text-popover-foreground";
    host.dataset.testid = testId;
    host.dataset.sheetSize = size;
    host.dataset.presentation = docked ? "docked" : "modal";
    host.tabIndex = -1;
    if (docked) {
      host.setAttribute("role", "complementary");
      host.setAttribute("aria-labelledby", titleId);
    } else {
      host.removeAttribute("role");
      host.removeAttribute("aria-labelledby");
    }
    if (focused.current?.isConnected && host.contains(focused.current))
      focused.current.focus({ preventScroll: true });
    else if (!docked) host.focus({ preventScroll: true });
    return () => {
      const current = document.activeElement;
      if (current instanceof HTMLElement && host.contains(current)) focused.current = current;
      host.remove();
    };
  }, [host, docked, dockHost, modalHost, open, size, testId, titleId]);
  return (
    <Sheet open={open && !docked} onOpenChange={onOpenChange}>
      <SheetContent
        className={`overflow-hidden data-[side=right]:w-full ${sheetWidthClass(size)}`}
        showCloseButton={false}
        aria-labelledby={titleId}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          if (dockedRef.current) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (focused.current?.isConnected) focused.current.focus({ preventScroll: true });
          else host?.focus({ preventScroll: true });
        }}
      >
        <div ref={setModalHost} className="min-h-0 flex-1" />
      </SheetContent>
      {open && host
        ? createPortal(
            <>
              <RecordBody {...props} titleId={titleId} />
              <IconButton
                variant="ghost"
                className="absolute top-4 right-3"
                size="icon-sm"
                label={t("common.close")}
                data-testid={closeTestId ?? `${testId}-close`}
                onClick={() => onOpenChange(false)}
              >
                <XIcon />
              </IconButton>
            </>,
            host,
          )
        : null}
    </Sheet>
  );
}

export function RecordSheet(props: RecordSheetProps) {
  const { t } = useI18n();
  const { open, onOpenChange, size = "default", testId, closeTestId } = props;
  if (props.dock) return <DockableRecordSheet {...props} />;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className={`overflow-y-auto data-[side=right]:w-full [&>[data-slot=sheet-close]]:top-4 ${sheetWidthClass(size)}`}
        closeLabel={t("common.close")}
        closeTestId={closeTestId}
        data-testid={testId}
        data-sheet-size={size}
        aria-describedby={undefined}
      >
        <RecordBody {...props} />
      </SheetContent>
    </Sheet>
  );
}
