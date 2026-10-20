import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { NotFoundPage, RouteErrorPage } from "@/components/failure-state";
import { PeopleAndAccessPage } from "@/pages/admin";
import { ApiAccessPage } from "@/pages/api-access";
import { AuditPage } from "@/pages/audit";
import { CatalogPage } from "@/pages/catalog";
import { CatalogDetailPage, type DetailResource } from "@/pages/catalog-detail";
import { ChatPage } from "@/pages/chat";
import { FilesPage } from "@/pages/files";
import { IntakePage } from "@/pages/intake";
import { KnowledgeSourcePage, KnowledgeSourcesPage } from "@/pages/knowledge-sources";
import { OverviewPage } from "@/pages/overview";
import { SettingsPage } from "@/pages/settings";
import { SkillPage, SkillsPage } from "@/pages/skills";
import { UsagePage } from "@/pages/usage";
import { cockpitBasePath } from "./installation-context";
import { absolute } from "./links";
import {
  CHAT_ROUTES,
  movedTarget,
  PAGE_ROUTES,
  type PageRoute,
  REDIRECT_ROUTES,
} from "./route-table";
import { useSession } from "./session";
import { AppShell } from "./shell";

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFoundPage });

const [CHAT_PATH, NEW_CHAT_PATH, CONVERSATION_PATH] = CHAT_ROUTES;

const chatRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: CHAT_PATH, component: ChatPage }),
  createRoute({ getParentRoute: () => rootRoute, path: NEW_CHAT_PATH, component: ChatPage }),
  createRoute({ getParentRoute: () => rootRoute, path: CONVERSATION_PATH, component: ChatPage }),
];

const PAGE_COMPONENTS: Record<PageRoute, () => React.ReactElement> = {
  "/": OverviewPage,
  "/audit": AuditPage,
  "/usage": UsagePage,
  "/people": PeopleAndAccessPage,
  "/api-access": ApiAccessPage,
  "/settings": SettingsPage,
};

const dedicatedRoutes = PAGE_ROUTES.map((path) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: PAGE_COMPONENTS[path] }),
);

const redirectRoutes = REDIRECT_ROUTES.map((path) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => {
      window.location.replace(absolute(movedTarget(window.location.search)));
    },
  }),
);

const knowledgeRoutes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/intake",
    component: () => <IntakePage permissions={useSession().permissions} />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/knowledge",
    component: () => <KnowledgeSourcesPage permissions={useSession().permissions} />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/knowledge/$resourceId",
    component: () => <KnowledgeSourcePage permissions={useSession().permissions} />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills",
    component: () => <SkillsPage permissions={useSession().permissions} />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills/$resourceId",
    component: () => <SkillPage permissions={useSession().permissions} />,
  }),
];

const filesRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/files", component: FilesPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/incoming/files",
    component: FilesPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/files/$resourceId",
    component: FilesPage,
  }),
];

const CATALOG_PAGES = ["workflows", "connectors"] as const satisfies readonly DetailResource[];

const catalogRoutes = CATALOG_PAGES.flatMap((resource) => [
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/${resource}`,
    component: () => {
      const session = useSession();
      return <CatalogPage resource={resource} permissions={session.permissions} />;
    },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/${resource}/$resourceId`,
    component: () => {
      const session = useSession();
      return <CatalogDetailPage resource={resource} permissions={session.permissions} />;
    },
  }),
]);

const routeTree = rootRoute.addChildren([
  ...chatRoutes,
  ...dedicatedRoutes,
  ...redirectRoutes,
  ...catalogRoutes,
  ...knowledgeRoutes,
  ...filesRoutes,
]);

export const router = createRouter({
  routeTree,
  basepath: cockpitBasePath(),
  trailingSlash: "never",
  defaultErrorComponent: RouteErrorPage,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
