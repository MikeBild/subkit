import { cn } from "@ui/lib/utils";
import { Check, Image as ImageIcon, Upload } from "lucide-react";
import { useRef } from "react";
import type { BrandingPalette, TenantBranding, TenantBrandingUpdate } from "@/api/tenant-branding";
import { useSession } from "@/app/session";
import { Button } from "@/components/cockpit/patterns/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/cockpit/patterns/controls";
import { SectionHeading } from "@/components/cockpit/patterns/section";
import {
  BRANDING_PALETTES,
  BRANDING_SWATCHES,
  brandingDraftAppIcon,
  brandingDraftLogo,
  brandingPreviewLogo,
  brandingWorkspaceName,
} from "@/features/settings/model/branding";
import { useI18n } from "@/lib/i18n-context";
import { BrandingIconUpload } from "./branding-icon-upload";
import { BrandingLogo } from "./branding-logo";

export function BrandingForm({
  draft,
  saved,
  disabled,
  onChange,
  onUpload,
  onIconUpload,
}: {
  draft: TenantBrandingUpdate;
  saved: TenantBranding;
  disabled: boolean;
  onChange(value: Partial<TenantBrandingUpdate>): void;
  onUpload(theme: "light" | "dark", file: File): void;
  onIconUpload(file: File): void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-5">
      <FieldSet className="block rounded-xl border">
        <FieldLegend className="mb-0 ml-4 px-1" variant="label">
          {t("branding.wordmark")}
        </FieldLegend>
        <FieldGroup className="gap-4 p-4">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="branding-subtitle" className="gap-1">
              {t("branding.subtitle")}{" "}
              <span className="font-normal text-muted-foreground">({t("input.optional")})</span>
            </FieldLabel>
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
          <div className="grid grid-cols-3 gap-4">
            <BrandingIconUpload
              change={draft.app_icon ?? { operation: "keep" }}
              src={brandingDraftAppIcon(draft, saved)}
              disabled={disabled}
              onUpload={onIconUpload}
              onRemove={() => onChange({ app_icon: { operation: "remove" } })}
            />
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
          <FieldDescription className="-mt-2 text-xs">{t("branding.imageHint")}</FieldDescription>
        </FieldGroup>
      </FieldSet>
      <FieldSet className="block">
        <FieldLegend className="mb-2" variant="label">
          {t("branding.palette")}
        </FieldLegend>
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
              <span className="mt-3 mb-2 flex gap-1" aria-hidden="true">
                {BRANDING_SWATCHES[palette].map((color) => (
                  <span
                    key={color}
                    className={cn("h-5 min-w-0 flex-1 rounded-sm", color === "#f8fafc" && "border")}
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
        className="h-auto min-h-24 w-full gap-0 rounded-lg whitespace-normal border-dashed bg-background px-4 py-3 dark:bg-background [&>span]:flex-col"
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
    brandingDraftLogo(draft, saved, "dark") !== null ||
    brandingDraftAppIcon(draft, saved) !== null;
  const workspaceName =
    brandingWorkspaceName(
      { tenant: session.tenant, branding: { configured, display_name: draft.display_name } },
      false,
    ) ?? t("app.name");
  return (
    <section aria-labelledby="branding-preview-title">
      <div className="mb-2">
        <SectionHeading id="branding-preview-title" className="text-sm font-medium">
          {t("branding.preview")}
        </SectionHeading>
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
                      "grid shrink-0 place-items-center overflow-hidden rounded-md",
                      kind === "mobile" ? "size-7" : "size-8",
                      !src && "border border-dashed",
                      !src &&
                        (theme === "light"
                          ? "border-[#cbd5e1] bg-[#f8fafc]"
                          : "border-[#475569] bg-[#1e293b]"),
                    )}
                  >
                    {src ? (
                      <BrandingLogo key={src} src={src} />
                    ) : (
                      <ImageIcon className="size-4 text-muted-foreground" />
                    )}
                  </span>
                  <span
                    className={cn(
                      "grid min-w-0 leading-tight",
                      kind === "mobile" ? "text-[11px]" : "text-xs",
                    )}
                  >
                    <b className="truncate">{workspaceName}</b>
                    <span className="truncate text-muted-foreground">
                      {configured ? draft.subtitle : session.tenant.display_name}
                    </span>
                  </span>
                </div>
                <div
                  className={cn("mt-2 grid gap-1", kind === "mobile" ? "text-[11px]" : "text-xs")}
                >
                  <span className="rounded-md px-2 py-1.5">{t("nav.overview")}</span>
                  <span className="rounded-md bg-muted px-2 py-1.5 font-medium">
                    {t("resource.settings.title")}
                  </span>
                  {kind !== "mobile" ? (
                    <span className="rounded-md px-2 py-1.5">{t("nav.workflows")}</span>
                  ) : null}
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
