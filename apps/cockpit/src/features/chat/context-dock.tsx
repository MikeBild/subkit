import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/cockpit/icon-button";
import { RecordSheet, SectionHeading } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";

type ContextWorkspace = {
  docked: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
};

export function useContextDock(chatWorkspace: ContextWorkspace) {
  const [contextContainer] = useState(() => document.createElement("div"));
  const contextDock = useRef<HTMLElement>(null);
  const contextToggle = useRef<HTMLButtonElement>(null);
  const closeContext = () => {
    chatWorkspace.setOpen(false);
    contextToggle.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    const dock = contextDock.current;
    if (!dock) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      closeContext();
    };
    dock.addEventListener("keydown", dismiss);
    return () => dock.removeEventListener("keydown", dismiss);
  }, [chatWorkspace.docked, chatWorkspace.open, chatWorkspace.setOpen]);
  const attachContext = (host: HTMLDivElement | null) => {
    if (host && contextContainer.parentElement !== host) host.append(contextContainer);
  };
  return { contextContainer, contextDock, contextToggle, closeContext, attachContext };
}

export type ContextDock = ReturnType<typeof useContextDock>;

export function ChatContextDock({
  dock,
  width,
  playbook,
}: {
  dock: ContextDock;
  width: number;
  playbook: boolean;
}) {
  const { t } = useI18n();
  return (
    <aside
      ref={dock.contextDock}
      className="flex min-h-0 shrink-0 flex-col border-l bg-background"
      style={{ width }}
      data-testid="chat-context"
      data-presentation="docked"
      aria-labelledby="chat-context-title"
    >
      <div className="flex h-18 shrink-0 items-center gap-2 border-b px-4">
        <SectionHeading id="chat-context-title" className="min-w-0 flex-1 text-sm font-semibold">
          {t(playbook ? "chat.playbook.title" : "chat.context.title")}
        </SectionHeading>
        <IconButton
          label={t("common.close")}
          data-testid="chat-context-close"
          onClick={dock.closeContext}
        >
          <X />
        </IconButton>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
        <div ref={dock.attachContext} />
      </div>
    </aside>
  );
}

export function ChatContextSheet({
  dock,
  open,
  onOpenChange,
  playbook,
}: {
  dock: ContextDock;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  playbook: boolean;
}) {
  const { t } = useI18n();
  return (
    <RecordSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t(playbook ? "chat.playbook.title" : "chat.context.title")}
      testId="chat-context"
      closeTestId="chat-context-close"
    >
      <div ref={dock.attachContext} />
    </RecordSheet>
  );
}
