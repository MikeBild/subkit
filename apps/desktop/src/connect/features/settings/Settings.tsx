import { Button } from "@ui/atoms/button";
import { Input } from "@ui/atoms/input";
import { Panel } from "@ui/atoms/pill";
import { Switch } from "@ui/atoms/switch";
import { SettingsRow } from "@ui/molecules/settings-row";
import { StepFooter } from "@ui/molecules/step-footer";
import { ToggleGroup, ToggleGroupItem } from "@ui/molecules/toggle-group";
import { Cpu, Server } from "lucide-react";
import { useSignIn } from "../../adapter/index.ts";
import { type Command, quietHoursPatch, settingsFor } from "../../domain/index.ts";
import { LocalWorkspace } from "../local-workspace/index.ts";

export function Settings() {
  const { main, t, dispatch: onCommand } = useSignIn();
  if (!main) return null;
  const model = settingsFor(main);
  const quiet = model.quietHours;
  const saveQuiet = (change: Partial<typeof quiet>) => {
    const next = quietHoursPatch(quiet, change);
    if (next) onCommand({ type: "ChangeSettings", patch: { quietHours: next } });
  };
  const { update } = model;
  return (
    <div className="settings-view flex flex-col gap-2">
      <h1 className="sr-only">{t("settings.title")}</h1>
      {model.servers.length > 0 && (
        <Panel className="px-3 py-2">
          <h2 className="text-sm font-semibold">{t("profiles.title")}</h2>
          <ul className="mt-1 flex flex-col">
            {model.servers.map((server) => (
              <li key={server.profileId} className="flex items-center gap-2 py-0.5">
                <Server className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-sm">{server.host}</span>
                <Button
                  data-testid={`server-${server.profileId}-primary`}
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onCommand(
                      server.primary.command === "open"
                        ? { type: "OpenServer", profileId: server.profileId }
                        : { type: "SignInToServer", profileId: server.profileId },
                    )
                  }
                >
                  {t(server.primary.label)}
                </Button>
                <Button
                  data-testid={`server-${server.profileId}-remove`}
                  size="sm"
                  variant="ghost"
                  aria-label={t("profiles.remove.label", { name: server.host })}
                  onClick={() => onCommand({ type: "RemoveServer", profileId: server.profileId })}
                >
                  {t("profiles.remove")}
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <LocalWorkspace />
      <Panel className="divide-y px-3 py-0">
        <SettingsRow id="launch" label={t("settings.launchAtLogin")}>
          <Switch
            data-testid="settings-launch"
            id="launch"
            checked={model.launchAtLogin}
            onCheckedChange={(checked) =>
              onCommand({ type: "ChangeSettings", patch: { launchAtLogin: checked } })
            }
          />
        </SettingsRow>
        <SettingsRow id="quiet" label={t("settings.quiet")}>
          <div className="flex items-center gap-2">
            <Input
              data-testid="settings-quiet-start"
              type="time"
              aria-label={t("settings.quiet.from")}
              className="h-8 w-[5.5rem] px-2 font-mono text-sm"
              disabled={!quiet.enabled}
              value={quiet.start}
              onChange={(event) => saveQuiet({ start: event.target.value })}
            />
            <Input
              data-testid="settings-quiet-end"
              type="time"
              aria-label={t("settings.quiet.to")}
              className="h-8 w-[5.5rem] px-2 font-mono text-sm"
              disabled={!quiet.enabled}
              value={quiet.end}
              onChange={(event) => saveQuiet({ end: event.target.value })}
            />
            <Switch
              data-testid="settings-quiet"
              id="quiet"
              checked={quiet.enabled}
              onCheckedChange={(checked) => saveQuiet({ enabled: checked })}
            />
          </div>
        </SettingsRow>
        <SettingsRow label={t("settings.language")}>
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            aria-label={t("settings.language")}
            value={model.locale}
            onValueChange={(value) => {
              if (!value) return;
              onCommand({
                type: "ChangeSettings",
                patch: { locale: value === "de" || value === "en" ? value : "system" },
              });
            }}
          >
            <ToggleGroupItem data-testid="settings-language-system" value="system">
              {t("settings.language.system")}
            </ToggleGroupItem>
            <ToggleGroupItem data-testid="settings-language-de" value="de">
              DE
            </ToggleGroupItem>
            <ToggleGroupItem data-testid="settings-language-en" value="en">
              EN
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingsRow>
        <SettingsRow icon={Cpu} label={t("local.title")} hint={t("local.explain")}>
          <Button
            data-testid="settings-local-open"
            size="sm"
            variant="outline"
            onClick={() => onCommand({ type: "OpenLocalCapabilities" })}
          >
            {t("local.manage")}
          </Button>
        </SettingsRow>
      </Panel>
      <Panel className="flex flex-wrap items-center gap-3 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{t("updates.title")}</h2>
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {t(update.status.key, update.status.vars)}
          </p>
          {update.progress !== null && (
            <progress
              className="mt-2 h-1 w-full accent-primary"
              max={100}
              value={update.progress}
            />
          )}
        </div>
        {update.action && (
          <Button
            data-testid="settings-update-action"
            size="sm"
            variant={update.action.primary ? "default" : "outline"}
            disabled={!update.action.enabled}
            onClick={() => onCommand({ type: "RunUpdateAction" })}
          >
            {t(update.action.label)}
          </Button>
        )}
      </Panel>
      <StepFooter
        backOnly
        back={() => onCommand({ type: "GoBack" } satisfies Command)}
        backLabel={t("common.back")}
        nextLabel={t("common.next")}
      />
    </div>
  );
}
