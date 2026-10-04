import { useTheme } from "@chat-ui/index.ts";
import { Box, Text } from "ink";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";

export type ToastLevel = "error" | "warn" | "info" | "success";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  level: ToastLevel;
  title: string;
  body?: string;
  ttlMs?: number;
  action?: ToastAction;
  pushedAt?: number;
}

export interface ToastInput extends Omit<Toast, "id" | "pushedAt"> {
  id?: string;
}

interface ToastState {
  items: Toast[];
}

type ToastAction_Internal =
  | { type: "push"; toast: Toast }
  | { type: "dismiss"; id: string }
  | { type: "clear" }
  | { type: "tick"; now: number };

const SEVERITY_RANK: Record<ToastLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  success: 3,
};

export function toastReducer(state: ToastState, action: ToastAction_Internal): ToastState {
  switch (action.type) {
    case "push": {
      const idx = state.items.findIndex((t) => t.id === action.toast.id);
      if (idx >= 0) {
        const next = state.items.slice();
        next[idx] = action.toast;
        return { items: next };
      }
      return { items: [...state.items, action.toast] };
    }
    case "dismiss":
      return { items: state.items.filter((t) => t.id !== action.id) };
    case "clear":
      return { items: [] };
    case "tick": {
      const next = state.items.filter((t) => {
        if (!t.ttlMs || !t.pushedAt) return true;
        return action.now - t.pushedAt < t.ttlMs;
      });
      return next.length === state.items.length ? state : { items: next };
    }
  }
}

const initialState: ToastState = { items: [] };

export interface ToastQueueAPI {
  push: (t: ToastInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
  toasts: Toast[];
}

const ToastQueueContext = createContext<ToastQueueAPI | null>(null);

export interface ToastQueueProps {
  maxVisible?: number;
  defaultTtlMs?: number;
  clock?: () => number;
  children: React.ReactNode;
}

let counter = 0;
function generateId(): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `t-${Date.now().toString(36)}-${counter}`;
}

export function ToastQueue({
  maxVisible = 3,
  defaultTtlMs = 4000,
  clock = Date.now,
  children,
}: ToastQueueProps): React.ReactElement {
  const [state, dispatch] = useReducer(toastReducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const push = useCallback(
    (t: ToastInput): string => {
      const id = t.id ?? generateId();
      const ttlMs = t.ttlMs ?? defaultTtlMs;
      dispatch({
        type: "push",
        toast: {
          id,
          level: t.level,
          title: t.title,
          ...(t.body !== undefined ? { body: t.body } : {}),
          ttlMs,
          ...(t.action !== undefined ? { action: t.action } : {}),
          pushedAt: clock(),
        },
      });
      return id;
    },
    [clock, defaultTtlMs],
  );

  const dismiss = useCallback((id: string) => dispatch({ type: "dismiss", id }), []);
  const clear = useCallback(() => dispatch({ type: "clear" }), []);

  useEffect(() => {
    const interval = setInterval(() => dispatch({ type: "tick", now: clock() }), 250);
    return () => clearInterval(interval);
  }, [clock]);

  const visible = useMemo(() => {
    const sorted = state.items
      .slice()
      .sort((a, b) => {
        const r = SEVERITY_RANK[a.level] - SEVERITY_RANK[b.level];
        if (r !== 0) return r;
        return (a.pushedAt ?? 0) - (b.pushedAt ?? 0);
      })
      .slice(0, maxVisible);
    return sorted;
  }, [state.items, maxVisible]);

  const api = useMemo<ToastQueueAPI>(
    () => ({ push, dismiss, clear, toasts: visible }),
    [push, dismiss, clear, visible],
  );

  return (
    <ToastQueueContext.Provider value={api}>
      {children}
      {visible.length > 0 ? <ToastList toasts={visible} /> : null}
    </ToastQueueContext.Provider>
  );
}

export function useToast(): ToastQueueAPI {
  const ctx = useContext(ToastQueueContext);
  if (!ctx) {
    return {
      push: () => "",
      dismiss: () => undefined,
      clear: () => undefined,
      toasts: [],
    };
  }
  return ctx;
}

function ToastList({ toasts }: { toasts: Toast[] }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </Box>
  );
}

function ToastRow({ toast }: { toast: Toast }): React.ReactElement {
  const tokens = useTheme();
  const color =
    toast.level === "error"
      ? tokens.severity.error
      : toast.level === "warn"
        ? tokens.severity.warning
        : toast.level === "success"
          ? tokens.severity.success
          : tokens.severity.info;
  const icon =
    toast.level === "error"
      ? "✗"
      : toast.level === "warn"
        ? "▲"
        : toast.level === "success"
          ? "✓"
          : "i";
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={color} bold>
          {icon}
        </Text>
        <Text> </Text>
        <Text color={color} bold>
          {toast.title}
        </Text>
      </Box>
      {toast.body ? (
        <Box paddingLeft={2}>
          <Text color={tokens.severity.dim}>{toast.body}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
