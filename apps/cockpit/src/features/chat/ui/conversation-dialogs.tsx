import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError, type Conversation, deleteConversation, renameConversation } from "@/api/client";
import { ConfirmDialog, Field, FieldLabel, FormDialog, Input } from "@/components/cockpit/patterns";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";

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
  } = dialogs;
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
    </>
  );
}
