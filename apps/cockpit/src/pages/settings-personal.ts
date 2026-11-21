import type { Bootstrap } from "@/api/client";
import type { TranslationKey } from "@/lib/i18n";
import {
  AI_ACCESS_REFUSAL_KEY,
  aiAccessRefusal,
  isOwnKeyProvider,
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

export function workspaceAiStatus(session: PersonalSession): AreaStatus | null {
  const { ai_access: access } = session;
  return access.own_key && isOwnKeyProvider(access.provider) ? null : "waiting";
}

export function profileStatus(session: PersonalSession): AreaStatus | null {
  return session.principal.display_name?.trim() ? null : "nameMissing";
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
