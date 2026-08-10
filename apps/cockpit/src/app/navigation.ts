import {
  Activity,
  Bot,
  Boxes,
  Cable,
  FileStack,
  Gauge,
  History,
  Inbox,
  KeyRound,
  Library,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react";

export interface NavigationItem {
  label: string;
  path: string;
  permission: string;
  icon: LucideIcon;
  api: readonly string[];
}

export interface NavigationGroup {
  label: string;
  items: readonly NavigationItem[];
}

export const NAVIGATION: readonly NavigationGroup[] = [
  {
    label: "Work",
    items: [
      {
        label: "Chat",
        path: "/chat",
        permission: "conversation:read",
        icon: MessageSquare,
        api: ["GET /v1/conversations"],
      },
      {
        label: "Inbox",
        path: "/inbox",
        permission: "notification:read",
        icon: Inbox,
        api: ["GET /v1/notifications/inbox"],
      },
    ],
  },
  {
    label: "Build",
    items: [
      {
        label: "Workflows",
        path: "/workflows",
        permission: "workflow:read",
        icon: Workflow,
        api: ["GET /v1/workflows"],
      },
      {
        label: "Runs",
        path: "/runs",
        permission: "execution:read",
        icon: Activity,
        api: ["GET /v1/executions"],
      },
    ],
  },
  {
    label: "Resources",
    items: [
      {
        label: "Connectors",
        path: "/connectors",
        permission: "connector:read",
        icon: Cable,
        api: ["GET /v1/connectors"],
      },
      {
        label: "Knowledge",
        path: "/knowledge",
        permission: "knowledge:read",
        icon: Library,
        api: ["GET /v1/knowledge-sources"],
      },
      {
        label: "Skills",
        path: "/skills",
        permission: "skill:read",
        icon: Sparkles,
        api: ["GET /v1/skills"],
      },
      {
        label: "Files",
        path: "/files",
        permission: "file:read",
        icon: FileStack,
        api: ["GET /v1/files"],
      },
    ],
  },
  {
    label: "Govern",
    items: [
      {
        label: "Approvals",
        path: "/approvals",
        permission: "conversation:approve",
        icon: ListChecks,
        api: ["GET /v1/skill-candidates", "GET /v1/patch-candidates"],
      },
      {
        label: "Audit log",
        path: "/audit",
        permission: "audit:read",
        icon: History,
        api: ["GET /v1/audit-log"],
      },
      {
        label: "Usage",
        path: "/usage",
        permission: "stats:read:all",
        icon: Gauge,
        api: ["GET /v1/stats/executions"],
      },
    ],
  },
  {
    label: "Admin",
    items: [
      {
        label: "People",
        path: "/people",
        permission: "identity:read",
        icon: Users,
        api: ["GET /v1/identity/users"],
      },
      {
        label: "Access",
        path: "/access",
        permission: "rbac:read",
        icon: ShieldCheck,
        api: ["GET /v1/rbac/roles"],
      },
      {
        label: "API access",
        path: "/api-access",
        permission: "api_key:read",
        icon: KeyRound,
        api: ["GET /v1/identity/api-keys"],
      },
      {
        label: "Operations",
        path: "/operations",
        permission: "stats:read:all",
        icon: Bot,
        api: ["GET /v1/operator/health-digest"],
      },
      {
        label: "Settings",
        path: "/settings",
        permission: "identity:read",
        icon: Settings,
        api: ["GET /v1/settings"],
      },
    ],
  },
] as const;

export const ALL_PRODUCTS_ICON = Boxes;

export function visibleNavigation(permissions: readonly string[]): NavigationGroup[] {
  const allowed = new Set(permissions);
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter((item) => allowed.has(item.permission)),
  })).filter((group) => group.items.length > 0);
}

export function navigationItem(pathname: string): NavigationItem | undefined {
  return NAVIGATION.flatMap((group) => group.items).find((item) => pathname.startsWith(item.path));
}
