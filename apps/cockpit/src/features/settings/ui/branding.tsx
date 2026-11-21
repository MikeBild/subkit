import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, type Bootstrap } from "@/api/client";
import {
  readTenantBranding,
  resetTenantBranding,
  saveTenantBranding,
  type TenantBranding,
  type TenantBrandingUpdate,
} from "@/api/tenant-branding";
import { useSession } from "@/app/session";
import { useDirtyGuard } from "@/app/version-notice";
import { Button, ConfirmDialog, DataState } from "@/components/cockpit/patterns";
import { Alert, AlertDescription } from "@/components/cockpit/patterns/controls";
import {
  brandingDraft,
  readBrandingAppIcon,
  readBrandingLogo,
} from "@/features/settings/model/branding";
import { useI18n } from "@/lib/i18n-context";
import { BrandingForm } from "./branding-form";

export interface BrandingDraftHandle {
  save(): Promise<void>;
  discard(): void;
}

export function BrandingSettings({
  onDraft,
}: {
  onDraft(handle: BrandingDraftHandle | null): void;
}) {
  const session = useSession();
  const { t } = useI18n();
  const client = useQueryClient();
  const key = ["tenant-branding", session.tenant.id];
  const query = useQuery({ queryKey: key, queryFn: readTenantBranding });
  const [draft, setDraft] = useState<TenantBrandingUpdate | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [failure, setFailure] = useState<"image" | "conflict" | "save" | null>(null);
  const canWrite =
    session.permissions.includes("settings:write") &&
    session.permissions.includes("identity:write");
  useDirtyGuard(draft !== null);
  function apply(value: TenantBranding) {
    client.setQueryData(key, value);
    client.setQueryData<Bootstrap>(["bootstrap"], (current) =>
      current ? { ...current, branding: value } : current,
    );
    setDraft(null);
    setFailure(null);
    setResetOpen(false);
  }
  const mutation = useMutation({
    mutationFn: async (reset: boolean) => {
      if (!query.data) throw new Error("branding_not_loaded");
      const value = draft ?? brandingDraft(query.data);
      return reset ? resetTenantBranding(value.revision) : saveTenantBranding(value);
    },
    onSuccess: (value, reset) => {
      apply(value);
      if (reset) toast.success(t("branding.saved"));
    },
    onError: (error) => {
      setResetOpen(false);
      setFailure(
        error instanceof ApiError && error.status === 409
          ? "conflict"
          : error instanceof ApiError && error.code === "branding_image_invalid"
            ? "image"
            : "save",
      );
    },
  });
  const dirty = draft !== null;
  const { mutateAsync } = mutation;
  useEffect(() => {
    onDraft(
      dirty
        ? {
            save: () => mutateAsync(false).then(() => undefined),
            discard: () => {
              setDraft(null);
              setFailure(null);
            },
          }
        : null,
    );
  }, [dirty, mutateAsync, onDraft]);
  useEffect(() => () => onDraft(null), [onDraft]);
  if (query.isPending) return <DataState state="loading" testId="branding-loading" />;
  if (!query.data)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {t("branding.loadFailed")}{" "}
          <Button variant="ghost" data-testid="branding-retry" onClick={() => void query.refetch()}>
            {t("pattern.retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  const saved = query.data;
  const value = draft ?? brandingDraft(saved);
  const disabled = !canWrite || mutation.isPending || reading;
  function change(patch: Partial<TenantBrandingUpdate>) {
    setDraft((current) => ({ ...(current ?? brandingDraft(saved)), ...patch }));
    setFailure(null);
  }
  async function upload(theme: "light" | "dark", file: File) {
    setReading(true);
    setFailure(null);
    try {
      const logo = await readBrandingLogo(file);
      setDraft((current) => {
        const initial = current ?? brandingDraft(saved);
        return { ...initial, logos: { ...initial.logos, [theme]: logo } };
      });
    } catch {
      setFailure("image");
    } finally {
      setReading(false);
    }
  }
  async function uploadIcon(file: File) {
    setReading(true);
    setFailure(null);
    try {
      const icon = await readBrandingAppIcon(file);
      setDraft((current) => ({ ...(current ?? brandingDraft(saved)), app_icon: icon }));
    } catch {
      setFailure("image");
    } finally {
      setReading(false);
    }
  }
  return (
    <div data-testid="branding-settings" data-branding-editor className="grid min-w-0 gap-4">
      {!canWrite ? <p className="text-sm text-muted-foreground">{t("branding.readOnly")}</p> : null}
      <BrandingForm
        draft={value}
        saved={saved}
        disabled={disabled}
        onChange={change}
        onUpload={(theme, file) => void upload(theme, file)}
        onIconUpload={(file) => void uploadIcon(file)}
      />
      {failure ? (
        <Alert variant="destructive" data-testid="branding-error">
          <AlertDescription>
            {t(
              failure === "image"
                ? "branding.imageError"
                : failure === "conflict"
                  ? "branding.conflict"
                  : "branding.failed",
            )}
            {failure === "conflict" ? (
              <Button
                variant="ghost"
                data-testid="branding-reload"
                disabled={mutation.isPending}
                onClick={() =>
                  void query.refetch().then((result) => {
                    if (result.data) {
                      setDraft(null);
                      setFailure(null);
                    }
                  })
                }
              >
                {t("settings.reload")}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {canWrite && (saved.configured || draft) ? (
        <Button
          variant="outline"
          className="justify-self-start"
          disabled={disabled}
          onClick={() => setResetOpen(true)}
          data-testid="branding-reset"
        >
          {t("branding.reset")}
        </Button>
      ) : null}
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        object={t("branding.title")}
        verb={t("branding.reset")}
        consequence={t("branding.resetConsequence")}
        pending={mutation.isPending}
        testId="branding-reset-dialog"
        onConfirm={() =>
          mutation
            .mutateAsync(true)
            .then(() => undefined)
            .catch(() => undefined)
        }
      />
    </div>
  );
}
