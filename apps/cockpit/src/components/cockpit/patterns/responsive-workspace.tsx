import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

interface Inspector {
  id: string;
  size: "default" | "wide";
}

interface Workspace {
  width: number;
  owner: string | null;
  host: HTMLDivElement | null;
  claim(inspector: Inspector): () => void;
}

const WorkspaceContext = createContext<Workspace | null>(null);

export function inspectorWidth(width: number, size: Inspector["size"]): number {
  const minimum = size === "wide" ? 1408 : 1152;
  if (width < minimum) return 0;
  return Math.round(
    size === "wide"
      ? Math.min(720, Math.max(560, width * 0.42))
      : Math.min(560, Math.max(384, width * 0.36)),
  );
}

export function ResponsiveWorkspace({ children }: { children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [inspectors, setInspectors] = useState<Inspector[]>([]);
  const claim = useCallback((inspector: Inspector) => {
    setInspectors((current) => [
      ...current.filter((entry) => entry.id !== inspector.id),
      inspector,
    ]);
    return () => setInspectors((current) => current.filter((entry) => entry.id !== inspector.id));
  }, []);
  useEffect(() => {
    const target = element.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  const inspector = inspectors[0];
  const reserved = inspector ? inspectorWidth(width, inspector.size) : 0;
  const owner = reserved ? (inspector?.id ?? null) : null;
  const value = useMemo(() => ({ width, owner, host, claim }), [width, owner, host, claim]);
  return (
    <WorkspaceContext.Provider value={value}>
      <div
        ref={element}
        className="grid min-h-0 min-w-0 flex-1 overflow-hidden"
        style={{
          gridTemplateColumns: reserved ? `minmax(0, 1fr) ${reserved}px` : "minmax(0, 1fr)",
        }}
        data-testid="responsive-workspace"
        data-inspector-docked={Boolean(owner)}
      >
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">{children}</div>
        <div
          ref={setHost}
          className="min-h-0 min-w-0 overflow-hidden border-l bg-popover"
          hidden={!owner}
          data-testid="workspace-inspector"
        />
      </div>
    </WorkspaceContext.Provider>
  );
}

export function useWorkspaceWidth(): number {
  return useContext(WorkspaceContext)?.width ?? 0;
}

export function useInspectorDock(enabled: boolean, size: Inspector["size"]) {
  const workspace = useContext(WorkspaceContext);
  const id = useId();
  const claim = workspace?.claim;
  useEffect(() => {
    if (enabled && claim) return claim({ id, size });
  }, [claim, enabled, id, size]);
  return {
    docked: enabled && workspace?.owner === id,
    host: workspace?.host ?? null,
  };
}
