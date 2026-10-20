import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
import { Button, ConfirmDialog, DataState, SaveBar } from "@/components/cockpit/patterns";
import { Alert, AlertDescription } from "@/components/cockpit/patterns/controls";
import { SectionHeading } from "@/components/cockpit/patterns/section";
import { brandingDraft, readBrandingLogo } from "@/lib/branding";
import { useI18n } from "@/lib/i18n-context";
import { BrandingForm } from "./branding-form";

export function BrandingSettings() {
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
    toast.success(t("branding.saved"));
  }
  const mutation = useMutation({
    mutationFn: async (reset: boolean) => {
      if (!query.data) throw new Error("branding_not_loaded");
      const value = draft ?? brandingDraft(query.data);
      return reset ? resetTenantBranding(value.revision) : saveTenantBranding(value);
    },
    onSuccess: apply,
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
  return (
    <section
      data-testid="branding-settings"
      data-branding-editor
      className="min-w-0 pb-20"
      aria-labelledby="branding-title"
    >
      <div className="mb-5">
        <SectionHeading id="branding-title" className="text-lg font-semibold tracking-tight">
          {t("branding.title")}
        </SectionHeading>
        <p className="mt-1 text-sm text-muted-foreground">{t("branding.intro")}</p>
      </div>
      {!canWrite ? (
        <p className="mb-4 text-sm text-muted-foreground">{t("branding.readOnly")}</p>
      ) : null}
      <BrandingForm
        draft={value}
        saved={saved}
        disabled={disabled}
        onChange={change}
        onUpload={(theme, file) => void upload(theme, file)}
      />
      {failure ? (
        <Alert variant="destructive" className="mt-4" data-testid="branding-error">
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
      {canWrite ? (
        <SaveBar
          count={draft ? 1 : 0}
          line={draft ? t("branding.unsaved") : t("branding.previewHint")}
          description={draft ? t("branding.localDraft") : undefined}
          testId="branding-save-bar"
          discard={{
            onClick: () => {
              setDraft(null);
              setFailure(null);
            },
            disabled: !draft || reading,
          }}
          secondary={
            <Button
              variant="outline"
              disabled={disabled || (!saved.configured && !draft)}
              onClick={() => setResetOpen(true)}
              data-testid="branding-reset"
            >
              {t("branding.reset")}
            </Button>
          }
          save={{
            label: t("branding.save"),
            onClick: () => mutation.mutate(false),
            pending: mutation.isPending,
            disabled: !draft || reading || failure === "conflict",
          }}
        />
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
    </section>
  );
}
