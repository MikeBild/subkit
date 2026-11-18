import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiCall } from "@/api/call";
import { useSession } from "@/app/session";
import {
  Button,
  ChoiceCards,
  FieldError,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import {
  OWN_KEY_PROVIDER_COPY,
  OWN_KEY_PROVIDERS,
  PROVIDER_KEY_PAGES,
  PROVIDER_MARK,
} from "@/pages/ai-providers";
import { modelCatalogQueryKey, modelsFor } from "@/pages/settings-catalog";
import { Question } from "@/pages/settings-guided";
import { type AiAccessView, aiAccessView, type PersonalDrafts } from "@/pages/settings-personal";
import { KEY_MAX } from "@/pages/welcome-model";

const DEFAULT_MODEL = "__default__";
const OTHER_MODEL = "__other__";

export function WorkspaceAiArea({
  drafts,
  keyInvalid,
  disabled,
  onChange,
}: {
  drafts: PersonalDrafts;
  keyInvalid: boolean;
  disabled: boolean;
  onChange(change: PersonalDrafts): void;
}) {
  const session = useSession();
  const tenantId = session.tenant.id;
  const catalog = useQuery({
    queryKey: modelCatalogQueryKey(tenantId),
    queryFn: () => apiCall("get", "/v1/settings/catalog/models", { query: { tenant: tenantId } }),
    enabled: session.permissions.includes("settings:read"),
  });
  return (
    <WorkspaceAiQuestions
      view={aiAccessView(session.ai_access, drafts)}
      keyDraft={drafts.aiKey}
      keyInvalid={keyInvalid}
      models={
        modelsFor(catalog.data, aiAccessView(session.ai_access, drafts).provider)?.map((entry) => ({
          id: entry.model,
          name: entry.display_name,
        })) ?? []
      }
      disabled={disabled}
      onChange={onChange}
    />
  );
}

export function WorkspaceAiQuestions({
  view,
  keyDraft,
  keyInvalid,
  models,
  disabled,
  onChange,
}: {
  view: AiAccessView;
  keyDraft: string | undefined;
  keyInvalid: boolean;
  models: readonly { id: string; name: string }[];
  disabled: boolean;
  onChange(change: PersonalDrafts): void;
}) {
  const { t } = useI18n();
  const copy = OWN_KEY_PROVIDER_COPY[view.provider];
  const providerName = t(copy.name);
  const keyOpen = keyDraft !== undefined || view.keyNeeded;
  const keyPage = PROVIDER_KEY_PAGES[view.provider];
  const listed = models.some((model) => model.id === view.model);
  const [otherModel, setOtherModel] = useState(false);
  const freeModel = otherModel || models.length === 0 || (view.model !== "" && !listed);
  return (
    <div className="grid gap-5" data-testid="settings-area-workspace-ai">
      <Question
        title={t("settings.workspaceAi.provider")}
        help={t("settings.workspaceAi.providerHelp")}
        testId="settings-question-workspace-ai-provider"
      >
        <fieldset
          disabled={disabled}
          className="min-w-0"
          aria-label={t("settings.workspaceAi.provider")}
        >
          <ChoiceCards
            items={OWN_KEY_PROVIDERS.map((option) => ({
              icon: (
                <span aria-hidden="true" className="text-[11px] font-semibold">
                  {PROVIDER_MARK[option]}
                </span>
              ),
              title: t(OWN_KEY_PROVIDER_COPY[option].name),
              line: t(OWN_KEY_PROVIDER_COPY[option].line),
              selected: option === view.provider,
              onSelect: () => {
                setOtherModel(false);
                onChange({
                  aiProvider: option,
                  aiModel: undefined,
                  aiKey: option === view.stored ? undefined : (keyDraft ?? ""),
                });
              },
              testId: `settings-workspace-ai-provider-${option}`,
            }))}
          />
        </fieldset>
      </Question>
      <Question
        title={t("settings.workspaceAi.key")}
        help={t("settings.workspaceAi.keyMeta")}
        testId="settings-question-workspace-ai-key"
      >
        {keyOpen ? (
          <div className="grid gap-1.5">
            <div className="flex items-center gap-2">
              <Input
                type="password"
                value={keyDraft ?? ""}
                maxLength={KEY_MAX}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={copy.placeholder}
                disabled={disabled}
                aria-label={t("settings.workspaceAi.keyLabel")}
                aria-invalid={keyInvalid || undefined}
                onChange={(event) => onChange({ aiKey: event.target.value })}
                data-testid="settings-workspace-ai-key"
              />
              {view.keyStored ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => onChange({ aiKey: undefined })}
                  data-testid="settings-workspace-ai-key-cancel"
                >
                  {t("settings.workspaceAi.keyCancel")}
                </Button>
              ) : null}
            </div>
            {keyInvalid ? (
              <FieldError data-testid="settings-workspace-ai-key-error">
                {t("settings.workspaceAi.keySwitch", { provider: providerName })}
              </FieldError>
            ) : view.keyNeeded ? (
              <p className="text-xs text-muted-foreground">
                {t("settings.workspaceAi.keySwitch", { provider: providerName })}
              </p>
            ) : null}
          </div>
        ) : (
          <p
            className="flex min-h-9 flex-wrap items-center gap-x-1.5 text-sm"
            data-testid="settings-workspace-ai-key-state"
            data-stored={view.keyStored || undefined}
          >
            <span className={view.keyStored ? undefined : "text-muted-foreground"}>
              {t(view.keyStored ? "settings.secret.stored" : "settings.secret.notStored")}
            </span>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0"
              disabled={disabled}
              onClick={() => onChange({ aiKey: "" })}
              data-testid="settings-workspace-ai-key-edit"
            >
              {t(view.keyStored ? "settings.secret.replace" : "settings.secret.store")}
            </Button>
          </p>
        )}
        {keyPage ? (
          <a
            href={keyPage}
            target="_blank"
            rel="noreferrer"
            className="justify-self-start text-xs font-medium underline-offset-2 hover:underline"
            data-testid="settings-workspace-ai-key-where"
          >
            {t("settings.ai.key.where")}
          </a>
        ) : null}
      </Question>
      <Question
        title={t("settings.workspaceAi.model")}
        testId="settings-question-workspace-ai-model"
      >
        {freeModel ? (
          <div className="grid gap-2">
            <Input
              value={view.model}
              maxLength={200}
              disabled={disabled}
              aria-label={t("settings.ai.model.label")}
              placeholder={t("settings.ai.model.customPlaceholder")}
              onChange={(event) => onChange({ aiModel: event.target.value })}
              data-testid="settings-workspace-ai-model-other"
            />
            <button
              type="button"
              className="justify-self-start text-xs font-medium underline-offset-2 hover:underline disabled:opacity-60"
              disabled={disabled}
              onClick={() => {
                setOtherModel(false);
                onChange({ aiModel: "" });
              }}
              data-testid="settings-workspace-ai-model-default"
            >
              {t("settings.workspaceAi.modelDefault")}
            </button>
          </div>
        ) : (
          <Select
            value={view.model === "" ? DEFAULT_MODEL : view.model}
            disabled={disabled}
            onValueChange={(next) => {
              if (next === OTHER_MODEL) return setOtherModel(true);
              onChange({ aiModel: next === DEFAULT_MODEL ? "" : next });
            }}
          >
            <SelectTrigger
              className="w-full"
              aria-label={t("settings.ai.model.label")}
              data-testid="settings-workspace-ai-model"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem
                  value={DEFAULT_MODEL}
                  description={t("settings.workspaceAi.modelDefaultHelp", {
                    provider: providerName,
                  })}
                  data-testid="settings-workspace-ai-model-option-default"
                >
                  {t("settings.workspaceAi.modelDefault")}
                </SelectItem>
                {models.map((model) => (
                  <SelectItem
                    key={model.id}
                    value={model.id}
                    data-testid={`settings-workspace-ai-model-option-${model.id}`}
                  >
                    {model.name}
                  </SelectItem>
                ))}
                <SelectItem
                  value={OTHER_MODEL}
                  data-testid="settings-workspace-ai-model-option-other"
                >
                  {t("settings.workspaceAi.modelOther")}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </Question>
    </div>
  );
}
