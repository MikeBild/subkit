import type { FolderAccess } from "@shared/device/boundary.ts";
import { Button } from "@ui/atoms/button";
import { IconTile } from "@ui/atoms/icon-tile";
import { Input } from "@ui/atoms/input";
import { Label } from "@ui/atoms/label";
import { Panel, Pill } from "@ui/atoms/pill";
import { StatusDot } from "@ui/atoms/status-dot";
import { Switch } from "@ui/atoms/switch";
import { EmptyState } from "@ui/molecules/empty-state";
import { ErrorNotice, FieldError } from "@ui/molecules/error-notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui/molecules/select";
import { SettingsRow } from "@ui/molecules/settings-row";
import { StepFooter } from "@ui/molecules/step-footer";
import { Tabs, TabsList, TabsTrigger } from "@ui/molecules/tabs";
import { ToggleGroup, ToggleGroupItem } from "@ui/molecules/toggle-group";
import { ConfirmDialog } from "@ui/organisms/confirm-dialog";
import { AppWindow, Cpu, Folder, Globe, Laptop, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  type AllowanceRow,
  blockedAppCategories,
  blockedAppLabel,
  controlsDisabled,
  LOCAL_TABS,
  type LocalTab,
  rowsOf,
  TAB_LABEL,
  tabCounts,
} from "../../../shared/local/capabilities-model.ts";
import { useLocalCapabilities, useSignIn } from "../../adapter/index.ts";
import type { Command } from "../../domain/index.ts";

const ROW_ICON = { folder: Folder, website: Globe, app: AppWindow } as const;
const TAB_ICON = { folders: Folder, websites: Globe, apps: AppWindow, keepOut: ShieldCheck };

export function LocalCapabilities({
  device,
  signedIn,
  supported,
}: {
  device: string;
  signedIn: boolean;
  supported: boolean;
}) {
  if (!supported) return <MacOnlyCapabilities />;
  return <SupportedCapabilities device={device} signedIn={signedIn} />;
}

function MacOnlyCapabilities() {
  const { t } = useSignIn();
  return (
    <div className="flex flex-col gap-4" data-testid="local-capabilities-mac-only">
      <h1 className="sr-only">{t("local.title")}</h1>
      <EmptyState
        icon={Laptop}
        title={t("local.macOnly.title")}
        text={t("local.macOnly.body")}
        testId="local-mac-only"
      />
    </div>
  );
}

function SupportedCapabilities({ device, signedIn }: { device: string; signedIn: boolean }) {
  const { view, t, dispatch } = useSignIn();
  const local = useLocalCapabilities();
  const { state } = local;
  const [tab, setTab] = useState<LocalTab>("folders");
  const [access, setAccess] = useState<FolderAccess>("read");
  const [origin, setOrigin] = useState("");
  const [originError, setOriginError] = useState(false);
  const disabled = controlsDisabled(state);
  const enabled = state.view.enabled;
  const counts = tabCounts(state.view);
  const rows = rowsOf(state.view, tab);
  const phase = state.phase === "loading" ? "skeleton" : "ready";
  const remove = (row: AllowanceRow) => (
    <ConfirmDialog
      destructive
      testId="local-remove-confirm"
      trigger={
        <Button
          data-testid={`local-remove-${row.id}`}
          size="icon"
          variant="ghost"
          disabled={disabled}
          aria-label={t("local.remove.label", { name: row.name })}
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
      }
      title={t("local.remove.title", { name: row.name })}
      consequence={t(row.removeBody)}
      confirmLabel={t("local.remove.action")}
      onConfirm={() => local.remove(row.id)}
    />
  );
  return (
    <div className="flex flex-col gap-4" data-testid="local-capabilities">
      <h1 className="sr-only">{t("local.title")}</h1>
      <Panel className="px-3 py-1">
        <SettingsRow id="local-on" icon={Cpu} label={t("local.toggle")} hint={t("local.explain")}>
          <Switch
            data-testid="local-enabled"
            id="local-on"
            checked={enabled}
            disabled={state.phase !== "ready" || state.busy}
            onCheckedChange={(checked) => local.setPersonalEnabled(checked)}
          />
        </SettingsRow>
        <div className="pb-3">
          <span className="inline-flex min-h-6 items-center gap-2 rounded-full border bg-secondary px-2 text-xs font-medium">
            <StatusDot tone={signedIn ? "success" : "neutral"} />
            {device}
          </span>
        </div>
      </Panel>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(LOCAL_TABS.find((key) => key === value) ?? "folders");
          setOriginError(false);
        }}
      >
        <TabsList aria-label={t("local.tabs")}>
          {LOCAL_TABS.map((key) => (
            <TabsTrigger key={key} value={key} disabled={!enabled} data-testid={`local-tab-${key}`}>
              {t(TAB_LABEL[key])} ({counts[key]})
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div role="tabpanel" aria-label={t(TAB_LABEL[tab])} className="flex flex-col gap-4">
        {state.phase === "error" ? (
          <ErrorNotice
            kind="device_allowances_unavailable"
            title={t("local.error.title")}
            body={t("local.error.body")}
            testId="local-error"
            primary={{ label: t("err.retry"), onClick: local.reload }}
          />
        ) : rows.length === 0 && phase === "ready" ? (
          <EmptyState icon={TAB_ICON[tab]} title={t("local.empty")} />
        ) : (
          <Panel className="divide-y px-3 py-1">
            {rows.map((row) => (
              <SettingsRow
                key={row.id}
                icon={ROW_ICON[row.icon]}
                phase={phase}
                testId={`local-row-${row.id}`}
                label={<span className="break-all font-mono text-sm font-normal">{row.name}</span>}
              >
                {row.folderAccess && local.canSetAccess ? (
                  <Select
                    value={row.folderAccess}
                    disabled={disabled}
                    onValueChange={(value) =>
                      local.setAccess(row.id, value === "write" ? "write" : "read")
                    }
                  >
                    <SelectTrigger
                      data-testid={`local-access-${row.id}`}
                      aria-label={`${t("local.access")}: ${row.name}`}
                      className="w-44"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="read">{t("local.read")}</SelectItem>
                      <SelectItem value="write">{t("local.readWrite")}</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  row.access && <Pill tone="neutral">{t(row.access)}</Pill>
                )}
                {row.status && (
                  <span className="inline-flex w-32 items-center justify-end gap-2 text-xs text-muted-foreground">
                    <StatusDot tone={row.status.tone} />
                    {t(row.status.label)}
                  </span>
                )}
                {row.private && (
                  <Pill tone="neutral" className="h-auto min-h-6 whitespace-normal text-right">
                    {t("local.private")}
                  </Pill>
                )}
                {row.offLimits && <Pill tone="neutral">{t("local.offLimits")}</Pill>}
                {remove(row)}
              </SettingsRow>
            ))}
          </Panel>
        )}
        {tab === "apps" && (
          <Panel className="px-3 py-1">
            <SettingsRow
              id="local-permissions"
              icon={ShieldCheck}
              label={t("local.permissions")}
              hint={t("local.permissions.hint")}
            >
              <Button
                data-testid="local-permissions"
                variant="outline"
                size="sm"
                onClick={() => dispatch({ type: "OpenPermissions" } satisfies Command)}
              >
                {t("local.permissions.open")}
              </Button>
            </SettingsRow>
          </Panel>
        )}
        {tab === "apps" && (
          <Panel className="divide-y px-3 py-1">
            {blockedAppCategories().map((category) => (
              <div
                key={category}
                className="flex min-h-12 items-center gap-3 py-2 text-muted-foreground opacity-60"
                aria-disabled="true"
              >
                <IconTile icon={AppWindow} size="md" />
                <span className="min-w-0 flex-1 text-sm">{t(blockedAppLabel(category))}</span>
                <span className="text-xs">{t("local.blocked")}</span>
              </div>
            ))}
          </Panel>
        )}
        {tab === "websites" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled) return;
              const accepted = local.addSite(origin);
              setOriginError(!accepted);
              if (accepted) setOrigin("");
            }}
          >
            <Label htmlFor="local-origin">{t("local.origin")}</Label>
            <div className="mt-2 flex items-center gap-2">
              <Input
                data-testid="local-origin"
                id="local-origin"
                className="min-w-0 flex-1 font-mono"
                placeholder={t("local.origin.placeholder")}
                value={origin}
                disabled={disabled || !local.canAddSite}
                aria-invalid={originError}
                aria-describedby={originError ? "local-origin-error" : undefined}
                onChange={(event) => {
                  setOrigin(event.target.value);
                  setOriginError(false);
                }}
              />
              <Button
                data-testid="local-origin-add"
                type="submit"
                disabled={disabled || !local.canAddSite}
              >
                {t("local.add")}
              </Button>
            </div>
            <div className="min-h-12">
              {originError && (
                <FieldError id="local-origin-error">{t("local.origin.error")}</FieldError>
              )}
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {tab === "folders" && !local.canSetAccess && (
                <ToggleGroup
                  type="single"
                  variant="outline"
                  className="h-10 gap-0.5 rounded-control bg-muted p-1 pointer-coarse:h-11"
                  aria-label={t("local.access")}
                  value={access}
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (value === "read" || value === "write") setAccess(value);
                  }}
                >
                  <ToggleGroupItem
                    data-testid="local-access-read"
                    value="read"
                    className="h-8 rounded-sm border-0 bg-transparent px-3 text-sm font-medium text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground pointer-coarse:h-9"
                  >
                    {t("local.read")}
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    data-testid="local-access-write"
                    value="write"
                    className="h-8 rounded-sm border-0 bg-transparent px-3 text-sm font-medium text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground pointer-coarse:h-9"
                  >
                    {t("local.readWrite")}
                  </ToggleGroupItem>
                </ToggleGroup>
              )}
              {(tab === "folders" || tab === "keepOut") && (
                <Button
                  data-testid="local-choose-folder"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => local.pickFolder(access, tab === "keepOut")}
                >
                  <Folder className="size-4" aria-hidden />
                  {t("local.chooseFolder")}
                </Button>
              )}
              {tab === "apps" && (
                <Button
                  data-testid="local-choose-app"
                  variant="outline"
                  disabled={disabled || !local.canAddApp}
                  onClick={local.addApp}
                >
                  <AppWindow className="size-4" aria-hidden />
                  {t("local.chooseApp")}
                </Button>
              )}
            </div>
            <div className="min-h-12">
              {state.problem && <FieldError>{t(state.problem)}</FieldError>}
            </div>
          </div>
        )}
      </div>
      <StepFooter
        backOnly
        testId="local"
        back={() => dispatch({ type: "GoBack" } satisfies Command)}
        backLabel={t(view?.nav?.back ?? "common.back")}
        nextLabel={t("common.next")}
      />
    </div>
  );
}
