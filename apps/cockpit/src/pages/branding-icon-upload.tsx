import { Upload } from "lucide-react";
import { useRef } from "react";
import type { TenantBrandingUpdate } from "@/api/tenant-branding";
import { Button } from "@/components/cockpit/patterns/button";
import { useI18n } from "@/lib/i18n-context";

export function BrandingIconUpload({
  change,
  src,
  disabled,
  onUpload,
  onRemove,
}: {
  change: NonNullable<TenantBrandingUpdate["app_icon"]>;
  src: string | null;
  disabled: boolean;
  onUpload(file: File): void;
  onRemove(): void;
}) {
  const { t } = useI18n();
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <input
        type="file"
        ref={file}
        accept="image/png"
        className="hidden"
        disabled={disabled}
        aria-label={t("branding.appIcon")}
        data-testid="branding-file-app-icon"
        onChange={(event) => {
          const selected = event.target.files?.[0];
          if (selected) onUpload(selected);
          event.target.value = "";
        }}
      />
      <Button
        variant="outline"
        className="h-auto min-h-24 w-full gap-0 rounded-lg border-dashed bg-background px-4 py-3 whitespace-normal dark:bg-background [&>span]:flex-col"
        disabled={disabled}
        onClick={() => file.current?.click()}
        data-testid="branding-upload-app-icon"
      >
        {src ? (
          <img src={src} alt="" className="mb-2 size-8 rounded-md object-cover" />
        ) : (
          <Upload className="mb-2 text-muted-foreground" />
        )}
        <span>{t("branding.appIcon")}</span>
        <span className="mt-0.5 text-xs font-normal text-muted-foreground">
          {t("branding.appIconHint")}
        </span>
      </Button>
      {change.operation !== "remove" && src ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={onRemove}
          data-testid="branding-remove-app-icon"
        >
          {t("branding.removeAppIcon")}
        </Button>
      ) : null}
    </div>
  );
}
