import type { Bootstrap } from "@/api/client";
import type { TranslationKey } from "@/lib/i18n";
import type { LocalePreference } from "@/lib/locale-store";
import type { Theme } from "@/lib/theme-store";
import {
  AI_ACCESS_REFUSAL_KEY,
  aiAccessRefusal,
  isOwnKeyProvider,
  OWN_KEY_PROVIDER_COPY,
  type OwnKeyProvider,
} from "@/pages/ai-providers";
import type { AreaStatus, SettingAreaId } from "@/pages/settings-areas";

export interface PersonalDrafts {
  name?: string;
  workspaceName?: string;
  timezone?: string;
  aiProvider?: OwnKeyProvider;
  aiKey?: string;
  aiModel?: string;
}

type PersonalSession = Pick<Bootstrap, "principal" | "tenant" | "ai_access">;

type PersonalField = keyof PersonalDrafts;

export interface AiAccessChange {
  llm_provider: OwnKeyProvider;
  llm_api_key?: string;
  llm_model: string | null;
}

export interface PersonalChanges {
  ai: AiAccessChange | null;
  profile: { display_name: string } | null;
  workspace: { display_name?: string; timezone?: string } | null;
  count: number;
  invalid: PersonalField[];
  areas: SettingAreaId[];
}

export interface AiAccessView {
  stored: OwnKeyProvider | null;
  provider: OwnKeyProvider;
  model: string;
  keyStored: boolean;
  keyNeeded: boolean;
}

export function aiAccessView(
  access: PersonalSession["ai_access"],
  drafts: PersonalDrafts,
): AiAccessView {
  const stored = access.own_key && isOwnKeyProvider(access.provider) ? access.provider : null;
  const provider =
    drafts.aiProvider ??
    stored ??
    (isOwnKeyProvider(access.provider) ? access.provider : "anthropic");
  const switched = provider !== stored;
  return {
    stored,
    provider,
    model: drafts.aiModel ?? (switched ? "" : (access.model ?? "")),
    keyStored: !switched,
    keyNeeded: switched && drafts.aiProvider !== undefined,
  };
}

function aiAccessChange(
  access: PersonalSession["ai_access"],
  drafts: PersonalDrafts,
): { change: AiAccessChange | null; facets: number; keyMissing: boolean } {
  const view = aiAccessView(access, drafts);
  const key = drafts.aiKey?.trim() ?? "";
  const providerChanged = drafts.aiProvider !== undefined && drafts.aiProvider !== view.stored;
  const model = view.model.trim();
  const modelChanged = view.keyStored && model !== (access.model ?? "");
  const facets = (providerChanged ? 1 : 0) + (key ? 1 : 0) + (modelChanged ? 1 : 0);
  if (facets === 0) return { change: null, facets, keyMissing: false };
  return {
    change: {
      llm_provider: view.provider,
      ...(key ? { llm_api_key: key } : {}),
      llm_model: model || null,
    },
    facets,
    keyMissing: !key && !view.keyStored,
  };
}

export function personalChanges(session: PersonalSession, drafts: PersonalDrafts): PersonalChanges {
  const name = drafts.name?.trim();
  const profile =
    name !== undefined && name !== (session.principal.display_name ?? "")
      ? { display_name: name }
      : null;
  const workspaceName = drafts.workspaceName?.trim();
  const workspace = {
    ...(workspaceName !== undefined && workspaceName !== session.tenant.display_name
      ? { display_name: workspaceName }
      : {}),
    ...(drafts.timezone !== undefined && drafts.timezone !== session.tenant.timezone
      ? { timezone: drafts.timezone }
      : {}),
  };
  const workspaceCount = Object.keys(workspace).length;
  const ai = aiAccessChange(session.ai_access, drafts);
  return {
    ai: ai.change,
    profile,
    workspace: workspaceCount > 0 ? workspace : null,
    count: (profile ? 1 : 0) + workspaceCount + ai.facets,
    invalid: [
      ...(profile && !profile.display_name ? (["name"] as const) : []),
      ...(workspace.display_name === "" ? (["workspaceName"] as const) : []),
      ...(ai.keyMissing ? (["aiKey"] as const) : []),
    ],
    areas: [
      ...(profile ? (["profile"] as const) : []),
      ...(workspaceCount > 0 ? (["workspace"] as const) : []),
      ...(ai.change ? (["ai"] as const) : []),
    ],
  };
}

export function workspaceAiCard(
  session: PersonalSession,
  t: (key: TranslationKey) => string,
): {
  sentence: CardSentence;
  status: AreaStatus | null;
} {
  const { ai_access: access } = session;
  if (!access.own_key || !isOwnKeyProvider(access.provider))
    return {
      sentence: { key: "settings.overview.workspaceAi.missing", values: {} },
      status: "waiting",
    };
  return {
    sentence: {
      key: "settings.overview.workspaceAi.stored",
      values: { provider: t(OWN_KEY_PROVIDER_COPY[access.provider].name) },
    },
    status: null,
  };
}

interface CardSentence {
  key: TranslationKey;
  values: Record<string, string>;
}

const LANGUAGE_STATE: Record<LocalePreference, TranslationKey> = {
  auto: "settings.profile.state.language.auto",
  de: "language.native.de",
  en: "language.native.en",
};

const THEME_STATE: Record<Theme, TranslationKey> = {
  system: "settings.profile.state.theme.system",
  light: "settings.profile.state.theme.light",
  dark: "settings.profile.state.theme.dark",
};

export function profileCard(
  session: PersonalSession,
  look: { preference: LocalePreference; theme: Theme },
  t: (key: TranslationKey) => string,
): { sentence: CardSentence; status: AreaStatus | null } {
  const name = session.principal.display_name?.trim() ?? "";
  const values = {
    language: t(LANGUAGE_STATE[look.preference]),
    theme: t(THEME_STATE[look.theme]),
  };
  return name
    ? { sentence: { key: "settings.overview.profile", values: { name, ...values } }, status: null }
    : { sentence: { key: "settings.overview.profile.noName", values }, status: "nameMissing" };
}

export function workspaceCard(session: PersonalSession): CardSentence {
  return {
    key: "settings.overview.workspace",
    values: {
      name: session.tenant.display_name,
      timezone: session.tenant.timezone.replace(/_/g, " "),
    },
  };
}

export class PersonalSaveError extends Error {
  readonly reason: TranslationKey | null;

  constructor(reason: TranslationKey | null) {
    super("personal settings were not saved");
    this.name = "PersonalSaveError";
    this.reason = reason;
  }
}

export function personalRefusal(error: {
  status: number;
  code: string | null;
}): TranslationKey | null {
  if (error.code === "invalid_timezone") return "settings.personal.timezoneRejected";
  if (error.code === "workspace_admin_required") return "settings.personal.forbidden";
  if (error.code === "operator_change_pending") return "settings.personal.operatorPending";
  if (error.code === "revision_conflict") return "settings.personal.savedAtOnce";
  const refusal = aiAccessRefusal(error.code);
  return refusal ? AI_ACCESS_REFUSAL_KEY[refusal] : null;
}
