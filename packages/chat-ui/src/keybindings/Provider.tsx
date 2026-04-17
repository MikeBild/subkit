// Keybinding context — a scoped registry of named handlers. Replaces
// the ad-hoc `useInput` + `approvalInputDisabled` flag dance with a
// single source of truth. Components subscribe via `useKeybinding`
// with a context tag; the provider multiplexes matching `useInput`
// events to whichever handler is currently active.

import { useInput } from "ink";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef } from "react";
import type { KeybindingContext, KeybindingKey, KeybindingSpec } from "./schema.ts";

interface Handler {
  name: string;
  ctx: KeybindingContext;
  handler: () => void;
}

interface KeybindingContextValue {
  register: (h: Handler) => () => void;
  /**
   * The set of currently *active* contexts. A keybinding only fires
   * when its context is in this set. The chat.global context is always
   * present; palette / confirm / textarea flip on while those
   * components are mounted.
   */
  activeContexts: Set<KeybindingContext>;
  pushContext: (c: KeybindingContext) => () => void;
}

const KeybindingContextObj = createContext<KeybindingContextValue | null>(null);

export interface KeybindingProviderProps {
  /** Full binding list — merged with what any host override supplies. */
  schema: KeybindingSpec[];
  children: ReactNode;
}

export function KeybindingProvider({
  schema,
  children,
}: KeybindingProviderProps): React.ReactElement {
  const handlersRef = useRef<Handler[]>([]);
  const contextStackRef = useRef<KeybindingContext[]>(["chat.global"]);

  const register = useCallback((h: Handler) => {
    handlersRef.current.push(h);
    return () => {
      handlersRef.current = handlersRef.current.filter((x) => x !== h);
    };
  }, []);

  const pushContext = useCallback((c: KeybindingContext) => {
    contextStackRef.current.push(c);
    return () => {
      const idx = contextStackRef.current.lastIndexOf(c);
      if (idx >= 0) contextStackRef.current.splice(idx, 1);
    };
  }, []);

  const match = (
    spec: KeybindingKey,
    input: string,
    key: Parameters<Parameters<typeof useInput>[0]>[1],
  ): boolean => {
    switch (spec.type) {
      case "char":
        if (input.toLowerCase() !== spec.char.toLowerCase()) return false;
        if (spec.ctrl && !key.ctrl) return false;
        if (!spec.ctrl && key.ctrl) return false;
        if (spec.shift && !key.shift) return false;
        if (spec.meta && !key.meta) return false;
        return true;
      case "enter":
        return key.return;
      case "escape":
        return key.escape;
      case "tab":
        if (!key.tab) return false;
        if (spec.shift && !key.shift) return false;
        return true;
      case "backspace":
        return key.backspace;
      case "delete":
        return key.delete;
      case "upArrow":
        return key.upArrow;
      case "downArrow":
        return key.downArrow;
      case "leftArrow":
        return key.leftArrow;
      case "rightArrow":
        return key.rightArrow;
    }
  };

  useInput(
    (input, key) => {
      const active = new Set(contextStackRef.current);
      for (const h of handlersRef.current) {
        if (!active.has(h.ctx)) continue;
        const spec = schema.find((s) => s.name === h.name);
        if (!spec) continue;
        if (match(spec.key, input, key)) {
          h.handler();
          return;
        }
      }
    },
    { isActive: true },
  );

  const value: KeybindingContextValue = {
    register,
    pushContext,
    activeContexts: new Set(contextStackRef.current),
  };
  return <KeybindingContextObj.Provider value={value}>{children}</KeybindingContextObj.Provider>;
}

/**
 * Register a handler for a named keybinding. The handler fires only
 * while `context` is in the provider's active stack.
 */
export function useKeybinding(name: string, context: KeybindingContext, handler: () => void): void {
  const kb = useContext(KeybindingContextObj);
  useEffect(() => {
    if (!kb) return;
    return kb.register({ name, ctx: context, handler });
  }, [kb, name, context, handler]);
}

/**
 * Push a keybinding context while the component is mounted. Used by
 * modal-like surfaces (palette, confirm) so their bindings only fire
 * while visible.
 */
export function useActiveContext(context: KeybindingContext): void {
  const kb = useContext(KeybindingContextObj);
  useEffect(() => {
    if (!kb) return;
    return kb.pushContext(context);
  }, [kb, context]);
}
