import { Skeleton } from "@ui/atoms/skeleton";
import { cn } from "@ui/lib/utils";
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  type ReactNode,
  useContext,
  useEffect,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n-context";
import { STATUS_DOT, type StatusTone } from "./status-strip";

export interface SideDetailsValue {
  target: HTMLElement | null;
  reportTitle?: (title: string | null) => void;
}

export const SideDetailsContext = createContext<SideDetailsValue | null>(null);

const InSidePanelContext = createContext(false);

type SideLayer = "page" | "overlay";

const SideLayerContext = createContext<SideLayer>("page");

export const SIDE_DETAILS_TARGET =
  "peer flex flex-col gap-6 empty:hidden [&:has([data-side-layer=overlay])>[data-side-layer=page]]:hidden";

export function SideOverlayLayer({ children }: { children: ReactNode }) {
  return <SideLayerContext.Provider value="overlay">{children}</SideLayerContext.Provider>;
}

export function useSideDetailsAvailable(): boolean {
  return useContext(SideDetailsContext) !== null;
}

export function useInSidePanel(): boolean {
  return useContext(InSidePanelContext);
}

export function useReportPageTitle(title: string): void {
  const report = useContext(SideDetailsContext)?.reportTitle;
  const inside = useContext(InSidePanelContext);
  useEffect(() => {
    if (!report || inside || !title) return;
    report(title);
    return () => report(null);
  }, [report, inside, title]);
}

export function SideDetails({ children }: { children: ReactNode }) {
  const side = useContext(SideDetailsContext);
  return side?.target
    ? createPortal(
        <InSidePanelContext.Provider value={true}>{children}</InSidePanelContext.Provider>,
        side.target,
      )
    : null;
}

export function SideSection({
  title,
  first,
  testId,
  children,
}: {
  title: string;
  first?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  const layer = useContext(SideLayerContext);
  return (
    <section
      aria-label={title}
      data-slot="side-section"
      data-side-layer={layer}
      data-testid={testId}
      className={cn("flex min-w-0 flex-col gap-3 text-sm", first ? "order-first" : null)}
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

const SIDE_TEST_ID_PROPS = ["data-testid", "testId"] as const;

export function sideTestIds(node: ReactNode): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return child;
    const props: Record<string, unknown> = {};
    for (const name of SIDE_TEST_ID_PROPS) {
      const value = child.props[name];
      if (typeof value === "string" && value) props[name] = `side-${value}`;
    }
    const children = child.props.children as ReactNode;
    return children === undefined || children === null
      ? cloneElement(child, props)
      : cloneElement(child, props, sideTestIds(children));
  });
}

export function SideStatus({
  tone,
  line,
  more,
  loading,
  testId = "side-details-status",
}: {
  tone: StatusTone;
  line: ReactNode;
  more?: ReactNode;
  loading?: boolean;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <SideDetails>
      <SideSection first title={t("sidePanel.details.status")} testId={testId}>
        <div className="flex min-h-15 flex-col gap-1" role="status" data-slot="side-status-body">
          {loading ? (
            <p className="flex h-5 items-center gap-2" aria-busy="true">
              <Skeleton className="size-2 rounded-full" />
              <Skeleton className="h-3.5 w-2/3" />
            </p>
          ) : (
            <p className="flex items-start gap-2">
              <span
                aria-hidden="true"
                className={cn("mt-1.5 size-2 shrink-0 rounded-full", STATUS_DOT[tone])}
              />
              <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">
                {sideTestIds(line)}
              </span>
            </p>
          )}
          {more && !loading ? (
            <p className="truncate text-xs text-muted-foreground">{sideTestIds(more)}</p>
          ) : null}
        </div>
      </SideSection>
    </SideDetails>
  );
}
