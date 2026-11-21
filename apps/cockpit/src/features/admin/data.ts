import type { components } from "@cli-core/engine-api/openapi";
import { useQuery } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { useLiveQueryOptions } from "@/app/live-events";
import { isAppUserEmail } from "@/features/admin/model/app-user";
import { reportFailure } from "@/lib/action-failure";
import type { Translate, TranslationKey } from "@/lib/i18n";
import { useInfiniteList } from "@/lib/use-infinite-list";
import { personRefusal } from "./model/admin-model";
import { personEmailText } from "./model/apps-model";

export type Envelope<T> = { items: T[] };

export type UserItem = components["schemas"]["UserDetail"];

export type RoleItem = components["schemas"]["RbacRoleDetail"];

export type GroupItem = components["schemas"]["RbacGroupDetail"];

export type GrantItem = components["schemas"]["RbacGrant"];

export interface RecordItem {
  id: string;
  name?: string | null;
  slug?: string | null;
  display_name?: string | null;
  current_version_id?: string | null;
  current_version?: number | null;
}

const fetchPeople = () => apiCall("get", "/v1/identity/users", { query: { limit: 200 } });

const fetchRoles = () => apiCall("get", "/v1/rbac/roles", {});

const fetchGroups = () => apiCall("get", "/v1/rbac/groups", {});

const fetchGrants = () => apiCall("get", "/v1/rbac/grants", {});

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
    queryFn: () => apiCall("get", "/v1/rbac/roles/{id}", { path: { id: role?.id ?? "" } }),
    enabled: Boolean(role),
  });
}

export function withCurrentRole(names: readonly string[], current: string | null): string[] {
  return current && !names.includes(current) ? [current, ...names] : [...names];
}

export function presentRoles(users: readonly Pick<UserItem, "role">[]): string[] {
  return [...new Set(users.flatMap((user) => (user.role ? [user.role] : [])))];
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
  reportFailure(personRefusal(error instanceof ApiError ? error : null, t), error);
}
