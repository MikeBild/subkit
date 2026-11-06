import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { useLiveQueryOptions } from "@/app/live-events";
import { isAppUserEmail } from "@/lib/app-user";
import type { TranslationKey } from "@/lib/i18n";
import type { useI18n } from "@/lib/i18n-context";
import { useInfiniteList } from "@/lib/use-infinite-list";
import { personRefusal } from "@/pages/admin-model";
import { personEmailText } from "@/pages/apps-model";

export type Envelope<T> = { items: T[] };

export type Translate = ReturnType<typeof useI18n>["t"];

export const INVITE_TTL_HOURS = 24;

export interface UserItem {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  status: string;
  oauth_connections?: number;
  groups?: { id: string; name: string }[] | null;
  identities?: { provider_id: string; product_id: string | null; last_seen_at: string }[];
}

export interface RoleItem {
  id: string;
  name: string;
  description: string | null;
  is_builtin: boolean;
  permissions?: string[];
  member_count?: number;
}

export interface GroupItem {
  member_count?: number;
  member_ids?: string[];
  id: string;
  name: string;
  description: string | null;
}

export interface GrantItem {
  id: string;
  subject_type: string;
  subject_id: string;
  resource_type: string;
  resource_id: string;
  permission: string;
  expires_at: string | null;
}

export interface RecordItem {
  id: string;
  name?: string | null;
  slug?: string | null;
  display_name?: string | null;
  current_version_id?: string | null;
  current_version?: number | null;
}

interface RoleDetail extends RoleItem {
  permissions: string[];
}

export interface PermissionItem {
  name: string;
  description: string;
  resource_type: string;
}

const fetchPeople = () => apiRequest<Envelope<UserItem>>("/v1/identity/users?limit=200");

const fetchRoles = () => apiRequest<Envelope<RoleItem>>("/v1/rbac/roles");

const fetchGroups = () => apiRequest<Envelope<GroupItem>>("/v1/rbac/groups");

const fetchGrants = () => apiRequest<Envelope<GrantItem>>("/v1/rbac/grants");

export function usePeople(enabled = true) {
  const live = useLiveQueryOptions();
  return useQuery({ queryKey: ["admin", "people"], queryFn: fetchPeople, enabled, ...live });
}

export function usePeopleList(enabled = true, app: string | null = null) {
  const list = useInfiniteList<UserItem>("/v1/identity/users", app ? { product_id: app } : {}, {
    enabled,
    queryKey: ["admin", "people", "list", app ?? "all"],
  });
  const { query } = list;
  return {
    ...list,
    view: {
      data: list.first ? { items: list.items } : undefined,
      error: query.error,
      failureReason: query.failureReason,
      isPending: query.isPending,
      refetch: query.refetch,
    },
  };
}

export function useRoles(enabled = true) {
  const live = useLiveQueryOptions();
  return useQuery({ queryKey: ["admin", "roles"], queryFn: fetchRoles, enabled, ...live });
}

export function useGroups(enabled = true) {
  const live = useLiveQueryOptions();
  return useQuery({ queryKey: ["admin", "groups"], queryFn: fetchGroups, enabled, ...live });
}

export function useGrants(enabled = true) {
  const live = useLiveQueryOptions();
  return useQuery({ queryKey: ["admin", "grants"], queryFn: fetchGrants, enabled, ...live });
}

export function useRoleDetail(role: RoleItem | null) {
  return useQuery({
    queryKey: ["admin", "role", role?.id],
    queryFn: () => apiRequest<RoleDetail>(`/v1/rbac/roles/${encodeURIComponent(role?.id ?? "")}`),
    enabled: Boolean(role),
  });
}

export function builtinRoleDescription(role: string, fallback: string | null, t: Translate) {
  const key: Record<string, TranslationKey> = {
    admin: "access.roleDescription.admin",
    member: "access.roleDescription.member",
    enduser: "access.roleDescription.enduser",
    metrics_scraper: "access.roleDescription.metricsScraper",
    portal_token_user: "access.roleDescription.portalTokenUser",
  };
  return key[role] ? t(key[role]) : fallback;
}

export function personEmailFact(user: UserItem, t: Translate) {
  return {
    label: t(isAppUserEmail(user.email) ? "apps.section.signIn" : "people.email"),
    value: personEmailText(user, t),
    testId: "people-sheet-email",
  };
}

export function refusalToast(error: unknown, t: Translate) {
  toast.error(personRefusal(error instanceof ApiError ? error : null, t));
}
