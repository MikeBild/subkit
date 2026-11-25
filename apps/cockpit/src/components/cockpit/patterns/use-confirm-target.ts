import { useState } from "react";

/** Props a controlled `ConfirmDialog` needs to open and close. */
export interface ConfirmDialogState {
  open: boolean;
  onOpenChange(open: boolean): void;
}

export interface ConfirmTarget<T> {
  /** What the open dialog asks about, or null while it is closed. */
  target: T | null;
  /** Opens the dialog for `next`. */
  ask(next: T): void;
  /** Closes the dialog, for example after the action succeeded. */
  close(): void;
  /**
   * Props for the `ConfirmDialog`. Pass `only` when one state drives several dialogs,
   * e.g. `dialog("delete")`. Pass `locked` to keep the dialog open while its action runs.
   */
  dialog(options?: { only?: T; locked?: boolean }): ConfirmDialogState;
}

/** Whether the dialog for `only` (or for any target, without `only`) is open. */
export function confirmOpen<T>(target: T | null, only?: T): boolean {
  return target !== null && (only === undefined || Object.is(target, only));
}

/**
 * State for a confirm dialog that asks about one thing at a time: a row to delete,
 * an action to confirm. Replaces a hand-rolled `useState<T | null>` plus its
 * `open`/`onOpenChange` wiring.
 */
export function useConfirmTarget<T>(): ConfirmTarget<T> {
  const [target, setTarget] = useState<T | null>(null);
  const close = () => setTarget(null);
  return {
    target,
    ask: (next) => setTarget(() => next),
    close,
    dialog: ({ only, locked = false } = {}) => ({
      open: confirmOpen(target, only),
      onOpenChange: (open) => {
        if (!open && !locked) close();
      },
    }),
  };
}
