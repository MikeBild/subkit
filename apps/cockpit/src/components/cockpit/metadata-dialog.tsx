import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n-context";

export type MetadataResource = "workflows" | "connectors" | "knowledge" | "skills";

const ENDPOINTS: Record<MetadataResource, string> = {
  workflows: "/v1/workflows",
  connectors: "/v1/connectors",
  knowledge: "/v1/knowledge-sources",
  skills: "/v1/skills",
};

/**
 * Renames a record. Structure is changed in the chat; this is the one direct
 * edit a record's page offers — so its button says "Umbenennen", not
 * "Metadaten bearbeiten", and the dialog it opens is headed by the record it
 * renames rather than by the button's own words a second time.
 *
 * It renders its own button unless the caller holds the open state: a page
 * that opens it from a menu passes `open` and `onOpenChange` and gets the
 * dialog alone.
 */
export function MetadataDialog({
  resource,
  id,
  title,
  version,
  open: controlled,
  onOpenChange,
}: {
  resource: MetadataResource;
  id: string;
  /** The record's current name. */
  title: string;
  /** A skill's version, sent back as the expected one. */
  version?: unknown;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (value: boolean) => (onOpenChange ?? setOwn)(value);
  const [name, setName] = useState(title);
  const mutation = useMutation({
    mutationFn: () => {
      const path =
        resource === "workflows"
          ? `/v1/workflows/${encodeURIComponent(id)}/metadata`
          : `${ENDPOINTS[resource]}/${encodeURIComponent(id)}`;
      const body = resource === "skills" ? { title: name, expected_version: version } : { name };
      return apiRequest<Record<string, unknown>>(path, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    },
    onSuccess: async () => {
      setOpen(false);
      toast.success(t("detail.saved"));
      await queryClient.invalidateQueries({ queryKey: ["catalog-detail", resource, id] });
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {controlled === undefined ? (
        <Button variant="outline" onClick={() => setOpen(true)} data-testid="detail-edit-metadata">
          <Pencil data-icon="inline-start" />
          {t("detail.rename")}
        </Button>
      ) : null}
      <DialogContent data-testid="detail-metadata-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("detail.editMetadataDescription")}</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="detail-record-name">{t("common.name")}</FieldLabel>
          <Input
            id="detail-record-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            data-testid="detail-metadata-name"
          />
        </Field>
        {/* A refused change says so. Without this the dialog stayed open and
            silent, and the reader could not tell a slow save from a failed one. */}
        {mutation.isError ? (
          <p className="text-sm text-destructive" role="alert" data-testid="detail-metadata-error">
            {t("detail.saveFailed")}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            data-testid="detail-metadata-cancel"
          >
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!name.trim() || name === title || mutation.isPending}
            onClick={() => mutation.mutate()}
            data-testid="detail-metadata-save"
          >
            {t("common.saveChanges")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
