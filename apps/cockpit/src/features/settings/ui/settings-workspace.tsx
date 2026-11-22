import { WORKSPACE_LANGUAGES, type WorkspaceLanguage } from "@shared/workspace-language.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui/molecules/select";
import { useSession } from "@/app/session";
import { FieldError, Input, TimezoneSelect } from "@/components/cockpit/patterns";
import { NAME_MAX } from "@/features/setup";
import { useI18n } from "@/lib/i18n-context";
import { type BrandingDraftHandle, BrandingSettings } from "./branding";
import { Question } from "./settings-guided";
import { WorkspaceDeletion } from "./workspace-deletion";

export function WorkspaceArea({
  name,
  nameInvalid,
  onName,
  timezone,
  onTimezone,
  language,
  onLanguage,
  disabled,
  onBrandingDraft,
}: {
  name: string;
  nameInvalid: boolean;
  onName(text: string): void;
  timezone: string;
  onTimezone(zone: string): void;
  language: WorkspaceLanguage;
  onLanguage(language: WorkspaceLanguage): void;
  disabled: boolean;
  onBrandingDraft(handle: BrandingDraftHandle | null): void;
}) {
  const { t } = useI18n();
  const session = useSession();
  return (
    <div className="grid gap-5" data-testid="settings-area-workspace">
      <WorkspaceQuestions
        name={name}
        nameInvalid={nameInvalid}
        onName={onName}
        timezone={timezone}
        onTimezone={onTimezone}
        language={language}
        onLanguage={onLanguage}
        disabled={disabled}
      />
      <Question
        title={t("settings.workspace.look")}
        help={t("settings.workspace.lookHelp")}
        testId="settings-question-workspace-look"
      >
        <BrandingSettings onDraft={onBrandingDraft} />
      </Question>
      {session.identity_memberships ? <WorkspaceDeletion /> : null}
    </div>
  );
}

export function WorkspaceQuestions({
  name,
  nameInvalid,
  onName,
  timezone,
  onTimezone,
  language,
  onLanguage,
  disabled,
}: {
  name: string;
  nameInvalid: boolean;
  onName(text: string): void;
  timezone: string;
  onTimezone(zone: string): void;
  language: WorkspaceLanguage;
  onLanguage(language: WorkspaceLanguage): void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      <Question
        title={t("settings.workspace.name")}
        help={t("settings.workspace.nameHelp")}
        testId="settings-question-workspace-name"
      >
        <Input
          value={name}
          maxLength={NAME_MAX}
          autoComplete="organization"
          disabled={disabled}
          aria-label={t("settings.workspace.name")}
          aria-invalid={nameInvalid || undefined}
          onChange={(event) => onName(event.target.value)}
          data-testid="settings-workspace-name"
        />
        {nameInvalid ? (
          <FieldError data-testid="settings-workspace-name-error">
            {t("settings.workspace.nameError")}
          </FieldError>
        ) : null}
      </Question>
      <Question
        title={t("settings.workspace.timezone")}
        help={t("settings.workspace.timezoneHelp")}
        testId="settings-question-workspace-timezone"
      >
        <TimezoneSelect
          value={timezone}
          onChange={onTimezone}
          label={t("settings.workspace.timezone")}
          disabled={disabled}
          testId="settings-workspace-timezone"
        />
      </Question>
      <Question
        title={t("settings.workspace.language")}
        help={t("settings.workspace.languageHelp")}
        testId="settings-question-workspace-language"
      >
        <Select
          value={language}
          onValueChange={(next) => {
            const chosen = WORKSPACE_LANGUAGES.find((option) => option === next);
            if (chosen) onLanguage(chosen);
          }}
          disabled={disabled}
        >
          <SelectTrigger
            className="w-full"
            aria-label={t("settings.workspace.language")}
            data-testid="settings-workspace-language"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORKSPACE_LANGUAGES.map((option) => (
              <SelectItem
                key={option}
                value={option}
                data-testid={`settings-workspace-language-${option}`}
              >
                {t(`language.native.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Question>
    </>
  );
}
