import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useReducer, useState } from "react";
import { toast } from "sonner";
import {
  ApiError,
  type Conversation,
  deleteConversation,
  renameConversation,
  setConversationShared,
} from "@/api/client";
import { ConfirmDialog, Field, FieldLabel, FormDialog, Input } from "@/components/cockpit/patterns";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import {
  conversationVisibility,
  VISIBILITY_IDLE,
  visibilityActionFor,
  visibilityDialogOpen,
  visibilityReducer,
} from "../model/visibility";

export function useConversationDialogs({
  activeId,
  startNew,
}: {
  activeId: string | null;
  startNew: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [visibility, dispatchVisibility] = useReducer(visibilityReducer, VISIBILITY_IDLE);
  const askVisibility = (target: Conversation) =>
    dispatchVisibility({
      type: "ask",
      target: {
        id: target.id,
        title: target.title || t("chat.untitled"),
        action: visibilityActionFor(conversationVisibility(target)),
      },
    });
  const confirmVisibility = async () => {
    if (visibility.phase !== "confirming" && visibility.phase !== "error") return;
    const { target } = visibility;
    dispatchVisibility({ type: "confirm" });
    try {
      const saved = await setConversationShared(target.id, target.action === "share");
      dispatchVisibility({ type: "saved", visibility: conversationVisibility(saved) });
      toast.success(
        t(target.action === "share" ? "chat.share.done" : "chat.unshare.done", {
          title: target.title,
        }),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["conversation", target.id] }),
      ]);
    } catch (error) {
      dispatchVisibility({ type: "failed" });
      reportFailure(t("chat.share.failed", { title: target.title }), error);
    }
  };
  const remove = useMutation({
    mutationFn: (target: Conversation) => deleteConversation(target.id),
    onSuccess: async (_result, target) => {
      setDeleteTarget(null);
      if (activeId === target.id) startNew();
      queryClient.removeQueries({ queryKey: ["conversation", target.id] });
      toast.success(t("chat.deleted", { title: target.title || t("chat.untitled") }));
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (error) =>
      reportFailure(
        error instanceof ApiError && error.status === 409
          ? t("chat.delete.running")
          : t("common.actionFailed"),
        error,
      ),
  });
  const rename = useMutation({
    mutationFn: () => renameConversation(renameTarget?.id ?? "", renameTitle.trim()),
    onSuccess: async () => {
      const renamed = renameTarget?.id;
      setRenameTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        renamed ? queryClient.invalidateQueries({ queryKey: ["conversation", renamed] }) : null,
      ]);
    },
  });
  return {
    renameTarget,
    setRenameTarget,
    renameTitle,
    setRenameTitle,
    deleteTarget,
    setDeleteTarget,
    remove,
    rename,
    visibility,
    askVisibility,
    confirmVisibility,
    cancelVisibility: () => dispatchVisibility({ type: "cancel" }),
  };
}

type ConversationDialogState = ReturnType<typeof useConversationDialogs>;

export function ConversationDialogs({ dialogs }: { dialogs: ConversationDialogState }) {
  const { t } = useI18n();
  const {
    renameTarget,
    setRenameTarget,
    renameTitle,
    setRenameTitle,
    deleteTarget,
    setDeleteTarget,
    remove,
    rename,
    visibility,
    confirmVisibility,
    cancelVisibility,
  } = dialogs;
  const visibilityTarget = visibility.phase === "idle" ? null : visibility.target;
  const sharing = visibilityTarget?.action !== "unshare";
  return (
    <>
      <FormDialog
        open={Boolean(renameTarget)}
        onOpenChange={(value) => !value && setRenameTarget(null)}
        title={t("chat.rename")}
        submit={{
          label: t("common.rename"),
          pending: rename.isPending,
          disabled: !renameTitle.trim(),
        }}
        onSubmit={() => rename.mutate()}
        testId="conversation-rename-dialog"
      >
        <Field>
          <FieldLabel htmlFor="conversation-rename-title">{t("resource.field.title")}</FieldLabel>
          <Input
            id="conversation-rename-title"
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value)}
            data-testid="conversation-rename-title"
          />
        </Field>
      </FormDialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(value) => !value && setDeleteTarget(null)}
        object={t("chat.delete.object")}
        verb={t("chat.delete.verb")}
        consequence={t("chat.delete.consequence", {
          title: deleteTarget?.title || t("chat.untitled"),
        })}
        destructive
        pending={remove.isPending}
        onConfirm={() => {
          if (deleteTarget) remove.mutate(deleteTarget);
        }}
        testId="conversation-delete-dialog"
      />

      <ConfirmDialog
        open={visibilityDialogOpen(visibility)}
        onOpenChange={(value) => !value && cancelVisibility()}
        title={t(sharing ? "chat.share.title" : "chat.unshare.title", {
          title: visibilityTarget?.title ?? "",
        })}
        consequence={t(sharing ? "chat.share.consequence" : "chat.unshare.consequence", {
          title: visibilityTarget?.title ?? "",
        })}
        confirmLabel={t(sharing ? "chat.share.verb" : "chat.unshare.verb")}
        pending={visibility.phase === "saving"}
        onConfirm={confirmVisibility}
        testId="conversation-visibility-dialog"
      />
    </>
  );
}
