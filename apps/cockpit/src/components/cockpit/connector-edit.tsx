import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { TextField } from "@/components/cockpit/form-field";
import { ConfirmDialog, FormDialog } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { credentialBody, offersKeyReplacement } from "@/pages/connector-detail-model";

type RecordValue = Record<string, unknown>;

const text = (record: RecordValue, key: string): string =>
  typeof record[key] === "string" ? (record[key] as string) : "";

export function ConnectorEditDialog({
  open,
  onOpenChange,
  id,
  record,
  headerName,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  id: string;
  record: RecordValue;
  headerName: string;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const authType = text(record, "auth_type") || null;
  const hasAddress = Boolean(text(record, "base_url"));
  const [name, setName] = useState(text(record, "display_name") || text(record, "name"));
  const [address, setAddress] = useState(text(record, "base_url"));
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      await apiRequest(`/v1/connectors/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim(),
          ...(hasAddress && address.trim() !== text(record, "base_url")
            ? { base_url: address.trim() }
            : {}),
        }),
      });
      const body = credentialBody(authType, secret, headerName);
      if (body)
        await apiRequest(`/v1/connectors/${encodeURIComponent(id)}/credentials`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      return Boolean(body);
    },
    onSuccess: async (replaced) => {
      toast.success(t(replaced ? "connectorEdit.savedWithKey" : "connectorEdit.saved"));
      onOpenChange(false);
      setSecret("");
      await client.invalidateQueries({ queryKey: ["catalog-detail", "connectors", id] });
      await client.invalidateQueries({ queryKey: ["connector-credential", id] });
      await client.invalidateQueries({ queryKey: ["connectors", "lookup"] });
    },
    onError: (failure) =>
      setError(
        failure instanceof ApiError && failure.message
          ? t("stepEditor.refused", { reason: failure.message })
          : t("common.actionFailed"),
      ),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("connectorEdit.title", {
        name: text(record, "display_name") || text(record, "name"),
      })}
      submit={{ label: t("common.save"), pending: save.isPending }}
      onSubmit={() => {
        if (!name.trim()) return setError(t("create.nameMissing"));
        if (hasAddress && !/^https?:\/\/\S+\.\S+/.test(address.trim()))
          return setError(t("create.connector.addressInvalid"));
        setError(null);
        save.mutate();
      }}
      error={error}
      testId="connector-edit-dialog"
    >
      <TextField
        id="connector-edit-name"
        label={t("create.name")}
        value={name}
        onChange={setName}
      />
      {hasAddress ? (
        <TextField
          id="connector-edit-address"
          type="url"
          label={t("create.connector.address")}
          value={address}
          onChange={setAddress}
          mono
        />
      ) : null}
      {offersKeyReplacement(authType) ? (
        <TextField
          id="connector-edit-secret"
          type="password"
          label={t("connectorEdit.secret")}
          placeholder={t("connectorEdit.secretPlaceholder")}
          help={t("connectorEdit.secretHelp")}
          value={secret}
          onChange={setSecret}
        />
      ) : null}
    </FormDialog>
  );
}

export function ConnectorDeleteDialog({
  open,
  onOpenChange,
  id,
  name,
  users,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  id: string;
  name: string;
  users: readonly string[];
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => apiRequest(`/v1/connectors/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      toast.success(t("connectorEdit.deleted", { name }));
      onOpenChange(false);
      await client.invalidateQueries({ queryKey: ["catalog"] });
      await client.invalidateQueries({ queryKey: ["connectors", "lookup"] });
      void navigate({ to: "/connectors" });
    },
    onError: () => toast.error(t("common.actionFailed")),
  });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => !remove.isPending && onOpenChange(next)}
      object={name}
      verb={t("workflowPage.delete")}
      consequence={
        users.length === 0
          ? t("connectorEdit.deleteUnused")
          : t(
              users.length === 1
                ? "connectorEdit.deleteBreaks.one"
                : "connectorEdit.deleteBreaks.other",
              {
                count: users.length,
                names: users.slice(0, 3).join(", "),
              },
            )
      }
      destructive
      pending={remove.isPending}
      onConfirm={async () => {
        await remove.mutateAsync().catch(() => undefined);
      }}
      testId="connector-delete-confirm"
    />
  );
}
