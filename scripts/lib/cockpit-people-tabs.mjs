const LISTS = {
  people: "/v1/identity/users",
  roles: "/v1/rbac/roles",
  groups: "/v1/rbac/groups",
  grants: "/v1/rbac/grants",
  workflows: "/v1/workflows",
  connectors: "/v1/connectors",
};

const OWN = {
  people: ["people", "roles"],
  roles: ["roles"],
  groups: ["groups"],
  grants: ["grants", "people", "groups", "workflows", "connectors"],
};

function listsIn(paths) {
  return Object.entries(LISTS)
    .filter(([, path]) => paths.some((seen) => seen === path))
    .map(([name]) => name);
}

export async function verifyPeopleLoadsPerTab(page, stand, where) {
  const seen = [];
  const listen = (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/")) seen.push(url.pathname);
  };
  page.on("request", listen);
  try {
    await stand.visit(page, "people");
    const first = listsIn(seen).filter((name) => !OWN.people.includes(name));
    if (first.length) throw new Error(`${where}: the people tab also loads ${first.join(", ")}`);
    for (const section of ["roles", "groups", "grants", "people"]) {
      seen.length = 0;
      await page.getByTestId(`people-tab-${section}`).click();
      await page.waitForLoadState("networkidle");
      const foreign = listsIn(seen).filter((name) => !OWN[section].includes(name));
      if (foreign.length)
        throw new Error(`${where}: switching to ${section} loads ${foreign.join(", ")}`);
    }
  } finally {
    page.off("request", listen);
  }
}
