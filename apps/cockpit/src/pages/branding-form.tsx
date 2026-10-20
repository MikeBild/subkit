import { Check, Upload } from "lucide-react";
import { useRef } from "react";
import type { BrandingPalette, TenantBranding, TenantBrandingUpdate } from "@/api/tenant-branding";
import { useSession } from "@/app/session";
import { BrandingLogo } from "@/components/cockpit/branding-logo";
import { Button } from "@/components/cockpit/patterns/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  BRANDING_PALETTES,
  BRANDING_SWATCHES,
  brandingDraftLogo,
  brandingPreviewLogo,
} from "@/lib/branding";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

export function BrandingForm({
  draft,
  saved,
  disabled,
  onChange,
  onUpload,
}: {
  draft: TenantBrandingUpdate;
  saved: TenantBranding;
  disabled: boolean;
  onChange(value: Partial<TenantBrandingUpdate>): void;
  onUpload(theme: "light" | "dark", file: File): void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-5">
      <FieldSet className="rounded-xl border p-4">
        <FieldLegend className="px-1" variant="label">
          {t("branding.wordmark")}
        </FieldLegend>
        <FieldGroup className="gap-4">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="branding-name">{t("branding.name")}</FieldLabel>
            <Input
              id="branding-name"
              className="h-9 rounded-lg px-3"
              style={{ backgroundColor: "var(--background)" }}
              value={draft.display_name ?? ""}
              maxLength={80}
              disabled={disabled}
              onChange={(event) => onChange({ display_name: event.target.value || null })}
              data-testid="branding-name"
            />
            <FieldDescription className="text-xs">{t("branding.nameHint")}</FieldDescription>
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="branding-subtitle">{t("branding.subtitle")}</FieldLabel>
            <Input
              id="branding-subtitle"
              className="h-9 rounded-lg px-3"
              style={{ backgroundColor: "var(--background)" }}
              value={draft.subtitle ?? ""}
              maxLength={160}
              disabled={disabled}
              onChange={(event) => onChange({ subtitle: event.target.value || null })}
              data-testid="branding-subtitle"
            />
            <FieldDescription className="text-xs">{t("branding.subtitleHint")}</FieldDescription>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            {(["light", "dark"] as const).map((theme) => (
              <LogoUpload
                key={theme}
                theme={theme}
                src={brandingDraftLogo(draft, saved, theme)}
                disabled={disabled}
                onUpload={(file) => onUpload(theme, file)}
                onRemove={() =>
                  onChange({ logos: { ...draft.logos, [theme]: { operation: "remove" } } })
                }
              />
            ))}
          </div>
          <FieldDescription className="text-xs">{t("branding.imageHint")}</FieldDescription>
        </FieldGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend variant="label">{t("branding.palette")}</FieldLegend>
        <ToggleGroup
          type="single"
          value={draft.palette ?? "standard"}
          onValueChange={(value) => {
            if (BRANDING_PALETTES.includes(value as BrandingPalette))
              onChange({ palette: value as BrandingPalette });
          }}
          disabled={disabled}
          aria-label={t("branding.palette")}
          className="grid w-full grid-cols-1 items-stretch gap-3 @min-[420px]/settings-panel:grid-cols-3"
          spacing={3}
        >
          {BRANDING_PALETTES.map((palette) => (
            <ToggleGroupItem
              key={palette}
              value={palette}
              data-testid={`branding-palette-${palette}`}
              className="group h-auto min-w-0 flex-col items-stretch gap-0 rounded-lg border p-3 text-left whitespace-normal data-[state=on]:border-ring data-[state=on]:bg-muted/50 data-[state=on]:ring-1 data-[state=on]:ring-ring/40"
            >
              <span className="flex items-center justify-between">
                {t(`branding.${palette}`)}
                <Check className="invisible group-data-[state=on]:visible" />
              </span>
              <span className="my-3 flex gap-1" aria-hidden="true">
                {BRANDING_SWATCHES[palette].map((color) => (
                  <span
                    key={color}
                    className="h-5 min-w-0 flex-1 rounded-sm border"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </span>
              <span className="text-xs leading-4 font-normal text-muted-foreground">
                {t(`branding.${palette}Hint`)}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </FieldSet>
      <BrandingPreview draft={draft} saved={saved} />
    </div>
  );
}

function LogoUpload({
  theme,
  src,
  disabled,
  onUpload,
  onRemove,
}: {
  theme: "light" | "dark";
  src: string | null;
  disabled: boolean;
  onUpload(file: File): void;
  onRemove(): void;
}) {
  const { t } = useI18n();
  const file = useRef<HTMLInputElement>(null);
  const label = t(theme === "light" ? "branding.lightLogo" : "branding.darkLogo");
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <input
        type="file"
        ref={file}
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        disabled={disabled}
        aria-label={label}
        data-testid={`branding-file-${theme}`}
        onChange={(event) => {
          const selected = event.target.files?.[0];
          if (selected) onUpload(selected);
          event.target.value = "";
        }}
      />
      <Button
        variant="outline"
        className="h-auto min-h-24 w-full border-dashed px-4 py-3 [&>span]:flex-col"
        disabled={disabled}
        onClick={() => file.current?.click()}
        data-testid={`branding-upload-${theme}`}
      >
        {src ? (
          <img src={src} alt="" className="mb-2 size-8 object-contain" />
        ) : (
          <Upload className="mb-2 text-muted-foreground" />
        )}
        <span>{label}</span>
        <span className="mt-0.5 text-xs font-normal text-muted-foreground">
          {t("branding.upload")}
        </span>
      </Button>
      {src ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={onRemove}
          data-testid={`branding-remove-${theme}`}
        >
          {t("branding.removeLogo")}
        </Button>
      ) : null}
    </div>
  );
}

function BrandingPreview({ draft, saved }: { draft: TenantBrandingUpdate; saved: TenantBranding }) {
  const { t } = useI18n();
  const session = useSession();
  const configured =
    draft.display_name !== null ||
    draft.subtitle !== null ||
    draft.palette !== null ||
    brandingDraftLogo(draft, saved, "light") !== null ||
    brandingDraftLogo(draft, saved, "dark") !== null;
  return (
    <section aria-labelledby="branding-preview-title">
      <div className="mb-2">
        <h3 id="branding-preview-title" className="text-sm font-medium">
          {t("branding.preview")}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("branding.previewHint")}</p>
      </div>
      <div className="rounded-xl border p-3">
        <div
          className="grid grid-cols-1 gap-3 @min-[600px]/settings-panel:grid-cols-[1fr_1fr_180px]"
          data-testid="branding-preview"
        >
          {(["light", "dark", "mobile"] as const).map((kind) => {
            const theme = kind === "light" ? "light" : "dark";
            const src = brandingPreviewLogo(draft, saved, theme);
            return (
              <div
                key={kind}
                data-preview-theme={theme}
                data-brand-palette={draft.palette ?? "standard"}
                className="flex h-64 min-w-0 flex-col rounded-lg border bg-background p-2 text-foreground"
              >
                {kind === "mobile" ? (
                  <p className="mb-2 text-[10px] text-muted-foreground">{t("branding.mobile")}</p>
                ) : null}
                <div className="flex min-w-0 items-center gap-2 border-b pb-2">
                  <span
                    className={cn(
                      "grid size-8 shrink-0 place-items-center overflow-hidden rounded-md",
                      !src && "bg-primary text-primary-foreground",
                    )}
                  >
                    <BrandingLogo key={src} src={src} />
                  </span>
                  <span className="grid min-w-0 text-xs leading-tight">
                    <b className="truncate">
                      {configured
                        ? draft.display_name || session.tenant.display_name
                        : t("app.name")}
                    </b>
                    <span className="truncate text-muted-foreground">
                      {configured ? draft.subtitle : session.tenant.display_name}
                    </span>
                  </span>
                </div>
                <div className="mt-2 grid gap-1 text-xs">
                  <span className="rounded-md px-2 py-1.5">{t("nav.overview")}</span>
                  <span className="rounded-md bg-muted px-2 py-1.5 font-medium">
                    {t("resource.settings.title")}
                  </span>
                  <span className="rounded-md px-2 py-1.5">{t("nav.people")}</span>
                </div>
                <p className="mt-auto px-2 text-[10px] text-muted-foreground">
                  powered by <b className="text-foreground">SubKit</b>
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
