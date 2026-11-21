import { Button } from "@ui/atoms/button";
import { IconTile } from "@ui/atoms/icon-tile";
import { Input } from "@ui/atoms/input";
import { Label } from "@ui/atoms/label";
import { Panel, Pill } from "@ui/atoms/pill";
import { Skel } from "@ui/atoms/skeleton";
import { Switch } from "@ui/atoms/switch";
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
import { Building2, Cpu, Database, Folder, KeyRound, Server, User } from "lucide-react";
import { useSignIn } from "../../adapter/index.ts";
import {
  type AiKind,
  aiFieldError,
  canContinue,
  ERROR_CODES,
  errorCopy,
  PHASE_LABEL,
  STEP_LABEL,
  stepName,
} from "./local-setup-model.ts";
import { useLocalSetup } from "./use-local-setup.ts";

const STEP_ICON = [Folder, User, KeyRound, Cpu] as const;
const PHASE_ICON = { database: Database, engine: Cpu, workspace: Building2 } as const;
const PROVIDERS = [
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["gemini", "Google"],
] as const;

export function LocalSetup() {
  const { s, form, a } = useLocalSetup();
  const { main, t, dispatch } = useSignIn();
  const current = stepName(s.step);
  const fieldError = aiFieldError(form, s.error);
  const copy = s.error && s.error !== "keyRejected" ? errorCopy(s.error) : null;
  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <IconTile icon={STEP_ICON[s.step] ?? Cpu} size="lg" />
        <h1 className="text-2xl font-semibold">
          {t(s.starting ? "workspace.starting" : STEP_LABEL[current])}
        </h1>
      </div>
      <div className="min-h-[440px]">
        {s.step === 0 && (
          <>
            <Panel>
              <p className="break-all font-mono text-sm">{s.folder}</p>
            </Panel>
            <Button
              data-testid="local-folder-choose"
              variant="outline"
              className="mt-4"
              disabled={s.working}
              onClick={a.pickFolder}
            >
              <Folder className="size-4" aria-hidden />
              {t("workspace.chooseFolder")}
            </Button>
            <div className="min-h-16">
              {s.folderRefusal && (
                <FieldError testId="local-folder-error">{t("workspace.folderError")}</FieldError>
              )}
            </div>
          </>
        )}
        {s.step === 1 && (
          <div className="flex flex-col gap-4">
            <div>
              <Label htmlFor="local-name">{t("workspace.name")}</Label>
              <Input
                data-testid="local-name"
                id="local-name"
                autoComplete="name"
                value={form.name}
                onChange={(event) => a.edit({ field: "name", value: event.target.value })}
                className="mt-2"
              />
            </div>
          </div>
        )}
        {s.step === 2 && (
          <>
            <div className="mb-4 grid gap-2 sm:grid-cols-2">
              {(["provider", "model"] as const satisfies readonly AiKind[]).map((kind) => (
                <Button
                  data-testid={`local-ai-${kind}`}
                  key={kind}
                  variant={form.aiKind === kind ? "secondary" : "outline"}
                  aria-pressed={form.aiKind === kind}
                  className="h-auto min-h-16 justify-start whitespace-normal p-4 text-left"
                  onClick={() => a.edit({ field: "aiKind", value: kind })}
                >
                  <IconTile icon={kind === "provider" ? KeyRound : Server} size="md" />
                  {t(kind === "provider" ? "workspace.providerKey" : "workspace.model")}
                </Button>
              ))}
            </div>
            {form.aiKind === "provider" ? (
              <div className="flex flex-col gap-4">
                <div>
                  <Label>{t("workspace.provider")}</Label>
                  <Select
                    value={form.provider}
                    onValueChange={(value) => {
                      const match = PROVIDERS.find(([id]) => id === value);
                      if (match) a.edit({ field: "provider", value: match[0] });
                    }}
                  >
                    <SelectTrigger
                      data-testid="local-provider"
                      aria-label={t("workspace.provider")}
                      className="mt-2"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map(([id, label]) => (
                        <SelectItem key={id} value={id}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="local-key">{t("workspace.key")}</Label>
                  <Input
                    data-testid="local-key"
                    id="local-key"
                    data-sensitive
                    autoComplete="off"
                    type="password"
                    value={form.key}
                    aria-invalid={fieldError !== null}
                    onChange={(event) => a.edit({ field: "key", value: event.target.value })}
                    className="mt-2"
                  />
                  <p className="mt-2 text-xs text-muted-foreground">{t("workspace.keyHint")}</p>
                </div>
              </div>
            ) : (
              <div>
                <Label htmlFor="local-origin">{t("workspace.address")}</Label>
                <Input
                  data-testid="local-origin"
                  id="local-origin"
                  inputMode="url"
                  spellCheck={false}
                  value={form.origin}
                  aria-invalid={fieldError !== null}
                  onChange={(event) => a.edit({ field: "origin", value: event.target.value })}
                  className="mt-2 font-mono"
                />
                <div className="mt-2 min-h-6">
                  <Pill tone="neutral">{t("workspace.private")}</Pill>
                </div>
              </div>
            )}
            <div className="min-h-20">
              {fieldError && <FieldError testId="local-ai-error">{t(fieldError)}</FieldError>}
            </div>
          </>
        )}
        {s.step === 3 && (
          <>
            <Panel className="divide-y py-1">
              {s.rows.map((row) => (
                <div key={row.phase} className="flex h-16 items-center gap-3">
                  <IconTile icon={PHASE_ICON[row.phase]} size="md" />
                  <span className="flex-1">{t(PHASE_LABEL[row.phase])}</span>
                  <div className="w-28" aria-live="polite">
                    {row.state === "done" ? (
                      <Pill tone="success">{t("workspace.done")}</Pill>
                    ) : row.state === "active" ? (
                      <Skel.Line />
                    ) : (
                      <span className="block h-6" />
                    )}
                  </div>
                </div>
              ))}
            </Panel>
            <p className="mt-4 text-xs text-muted-foreground">{t("workspace.hint")}</p>
            {!s.starting && (
              <Panel className="mt-4 px-3 py-0">
                <SettingsRow id="local-login" label={t("workspace.openAtLogin")}>
                  <Switch
                    data-testid="local-open-at-login"
                    id="local-login"
                    checked={main?.settings.launchAtLogin ?? false}
                    onCheckedChange={(checked) =>
                      dispatch({ type: "ChangeSettings", patch: { launchAtLogin: checked } })
                    }
                  />
                </SettingsRow>
              </Panel>
            )}
            <div className="mt-4 min-h-40">
              {main?.local.modelTools === false && !s.error && (
                <ErrorNotice
                  testId="local-model-tools"
                  tone="warning"
                  kind="model_tools_missing"
                  title={t("workspace.modelTools.title")}
                  body={t("workspace.modelTools.body")}
                />
              )}
              {copy && s.error && (
                <ErrorNotice
                  testId="local-error"
                  kind={ERROR_CODES[s.error]}
                  title={t(copy.title)}
                  body={copy.body ? t(copy.body) : undefined}
                  primary={{
                    label: t(
                      copy.remedy === "port"
                        ? "workspace.err.port.action"
                        : copy.remedy === "folder" && !s.starting
                          ? "workspace.chooseFolder"
                          : "err.retry",
                    ),
                    onClick: copy.remedy === "folder" && !s.starting ? a.back : a.retry,
                  }}
                />
              )}
            </div>
          </>
        )}
      </div>
      <StepFooter
        testId="local"
        back={s.starting ? undefined : a.back}
        backLabel={t("common.back")}
        nextLabel={t("common.next")}
        label={s.step === 3 ? t("workspace.done") : undefined}
        disabled={!canContinue(s, form)}
        next={a.next}
        skip={s.step === 2 ? a.skipAi : undefined}
        skipLabel={t("workspace.later")}
      />
    </div>
  );
}
