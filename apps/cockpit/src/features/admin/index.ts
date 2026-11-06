import { type PeopleSection, peopleAppFromUrl } from "@/app/links";
import { queryView } from "@/components/failure-state";
import type { TranslationKey } from "@/lib/i18n";
import { useApps } from "./apps-data";
import { type Envelope, useGrants, useGroups, usePeopleList, useRoles } from "./data";

export { AppsTab } from "./apps-tab";
export { GrantAccessDialog, GrantsTab } from "./grants-tab";
export { GroupsTab } from "./groups-tab";
export { InvitePersonDialog, PeopleTab } from "./people-tab";
export { CreateRecordDialog, RolesTab } from "./roles-tab";

export const SECTION_LABEL: Record<PeopleSection, TranslationKey> = {
  people: "people.section.people",
  roles: "access.roles",
  groups: "access.groups",
  grants: "access.grants",
  apps: "people.section.apps",
};

export const SECTION_ACTION: Partial<
  Record<PeopleSection, { label: TranslationKey; permission: string; testId: string }>
> = {
  people: { label: "people.create", permission: "identity:write", testId: "people-create" },
  roles: { label: "access.createRole", permission: "rbac:write", testId: "role-create" },
  groups: { label: "access.createGroup", permission: "rbac:write", testId: "group-create" },
  grants: { label: "access.createGrant", permission: "rbac:write", testId: "grant-create" },
};

export function usePeopleSectionViews(
  access: { identity: boolean; rbac: boolean; settings: boolean },
  section: PeopleSection | null,
  searchStr: string,
): Record<PeopleSection, ReturnType<typeof queryView>> {
  const empty = (data: Envelope<unknown>) => data.items.length === 0;
  return {
    people: queryView(
      usePeopleList(access.identity && section === "people", peopleAppFromUrl(searchStr)).view,
      empty,
    ),
    roles: queryView(useRoles(access.rbac && section === "roles"), empty),
    groups: queryView(useGroups(access.rbac && section === "groups"), empty),
    grants: queryView(useGrants(access.rbac && section === "grants"), empty),
    apps: queryView(useApps(access.settings && section === "apps"), empty),
  };
}
