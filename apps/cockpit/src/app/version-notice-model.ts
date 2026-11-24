export type ReloadActionInput = {
  dirty: boolean;
  preventDefault: () => void;
  warn: () => void;
  reload: () => void;
};

export function handleReloadAction({
  dirty,
  preventDefault,
  warn,
  reload,
}: ReloadActionInput): void {
  if (dirty) {
    preventDefault();
    warn();
  } else reload();
}
