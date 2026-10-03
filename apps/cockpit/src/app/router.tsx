import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { NotFoundPage, RouteErrorPage } from "@/components/failure-state";
import { PeopleAndAccessPage } from "@/pages/admin";
import { ApiAccessPage } from "@/pages/api-access";
import { AuditPage } from "@/pages/audit";
import { CatalogPage } from "@/pages/catalog";
import { CatalogDetailPage, type DetailResource } from "@/pages/catalog-detail";
import { ChatPage } from "@/pages/chat";
import { FilesPage } from "@/pages/files";
import { KnowledgeSourcePage, KnowledgeSourcesPage } from "@/pages/knowledge-sources";
import { OverviewPage } from "@/pages/overview";
import { SettingsPage } from "@/pages/settings";
import { SkillPage, SkillsPage } from "@/pages/skills";
import { UsagePage } from "@/pages/usage";
import { absolute } from "./links";
import {
  CHAT_ROUTES,
  legacyTarget,
  PAGE_ROUTES,
  type PageRoute,
  REDIRECT_ROUTES,
} from "./route-table";
import { useSession } from "./session";
import { AppShell } from "./shell";
import { routeViewTransition } from "./view-transition";

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFoundPage });

// One component behind all three chat paths: a conversation is chosen from the
// path, not from a different page. The paths are read off the table by
// position rather than mapped over it — a mapped tuple loses its literal types,
// and with them every `<Link to="/chat">` in the product.
const [CHAT_PATH, NEW_CHAT_PATH, CONVERSATION_PATH] = CHAT_ROUTES;

const chatRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: CHAT_PATH, component: ChatPage }),
  createRoute({ getParentRoute: () => rootRoute, path: NEW_CHAT_PATH, component: ChatPage }),
  createRoute({ getParentRoute: () => rootRoute, path: CONVERSATION_PATH, component: ChatPage }),
];

// Every page is its own module (CUI-PAGE-2). There is no generic resource
// renderer any more: a list that cannot say which columns it has cannot say
// which relations matter either.
//
// The map is exhaustive over PAGE_ROUTES, so a page route that exists only
// here — invisible to the navigation and to the conformity sweep — cannot be
// added: it has to be in the table first, and then it is swept.
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

// A moved page keeps its old address as a redirect, query included: an OAuth
// callback issued before the move still lands with its result.
//
// The query is read from `window.location.search` and the browser is sent on
// with `location.replace`, never through the router. Both of the router's own
// paths run the query through its JSON search serialiser: `location.searchStr`
// is `stringify(parse(raw))`, and a `redirect({ href })` is parsed again on
// commit — so `connected=1e5` arrived as `100000`, a long all-digit name lost
// precision, and `to` + `search` would quote `renewed=1`. A moved address is
// rare enough that a full load is the honest price for its query arriving
// exactly as it was sent.
const redirectRoutes = REDIRECT_ROUTES.map((path) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => {
      window.location.replace(absolute(legacyTarget(path, window.location.search)));
    },
  }),
);

// Wissen's three pages are their own modules: sources and skills open a
// record page, a file opens as a sheet over its list at the file's address.
const knowledgeRoutes = [
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
    path: "/files/$resourceId",
    component: FilesPage,
  }),
];

/** The catalogue renders the lists that share it: workflows and connectors. */
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

// One catch-all for every route: a render fault keeps the shell, the language
// and a way out, instead of the router's own English default.
export const router = createRouter({
  routeTree,
  basepath: "/cockpit",
  trailingSlash: "never",
  defaultErrorComponent: RouteErrorPage,
  defaultViewTransition: routeViewTransition,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
