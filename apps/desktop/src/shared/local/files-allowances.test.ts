import { describe, expect, test } from "bun:test";
import {
  DeviceAllowanceSchema,
  rootDigestMaterial,
  siteDigestMaterial,
} from "@shared/device/boundary.ts";
import { allowancesDigestMaterial } from "@shared/device/files.ts";
import { appDigest } from "./computer-allowances.ts";
import {
  addApp,
  addFolder,
  addKeepOut,
  addSite,
  allowancesDigest,
  allowancesView,
  computerOf,
  displayPath,
  EMPTY_LOCAL_FILES,
  folderDigest,
  folderStatus,
  type LocalFilesState,
  mayTouch,
  parseLocalFiles,
  removeAllowance,
  setFolderAccess,
  setPersonalEnabled,
  setRunnerId,
  sha256Hex,
  snapshotOf,
  wireAllowances,
} from "./files-allowances.ts";

const env = { home: "/Users/mike", data_dir: "/Users/mike/Library/Application Support/SubKit" };
const NOW = Date.parse("2026-11-21T10:00:00Z");
const fileId = (path: string) => sha256Hex(path.toLowerCase()).slice(0, 8);
const input = (path: string, file_id = fileId(path)) => ({
  picked: { path, volume_id: "16777232", file_id, bookmark: null },
  env,
  case_sensitive: false,
  now: NOW,
});

function added(
  state: LocalFilesState,
  path: string,
  access: "read" | "write" = "read",
): LocalFilesState {
  const outcome = addFolder(state, access, input(path));
  if (!outcome.ok) throw new Error(outcome.code);
  return outcome.state;
}

describe("local file allowances", () => {
  test("a picked folder is stored with its identity and a home-relative display", () => {
    const state = added(
      setPersonalEnabled(EMPTY_LOCAL_FILES, true),
      "/Users/mike/Documents/Rechnungen",
    );
    expect(state.folders).toMatchObject([
      {
        path: "/Users/mike/Documents/Rechnungen",
        display: "~/Documents/Rechnungen",
        access: "read",
        bookmark: null,
      },
    ]);
    expect(parseLocalFiles(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(parseLocalFiles({ nonsense: true })).toEqual(EMPTY_LOCAL_FILES);
  });

  test.each([
    ["/Users/mike", "the home folder"],
    ["/", "the disk root"],
    ["/System/Library", "a system folder"],
    ["/Users/mike/Library/Application Support/SubKit/files", "inside SubKit's data"],
    ["/Users/mike/Library/Application Support", "around SubKit's data"],
    ["/Users/mike/.ssh", "a hidden folder"],
  ])("refuses %s (%s)", (path) => {
    expect(addFolder(EMPTY_LOCAL_FILES, "read", input(path)).ok).toBe(false);
  });

  test("picking the same folder again changes its access and keeps its id", () => {
    const first = added(EMPTY_LOCAL_FILES, "/Users/mike/Docs");
    const again = added(first, "/users/MIKE/docs", "write");
    expect(again.folders).toHaveLength(1);
    expect(again.folders[0]?.id).toBe(first.folders[0]?.id as string);
    expect(again.folders[0]?.access).toBe("write");
  });

  test("the id comes from the root identity, so a renamed folder keeps its id and a replaced one changes its digest", () => {
    const first = added(EMPTY_LOCAL_FILES, "/Users/mike/Docs");
    const id = first.folders[0]?.id as string;
    expect(id).toMatch(/^fld_[a-f0-9]{32}$/);
    const renamed = addFolder(
      first,
      "read",
      input("/Users/mike/Documents", fileId("/Users/mike/Docs")),
    );
    if (!renamed.ok) throw new Error("expected ok");
    expect(renamed.id).toBe(id);
    expect(renamed.state.folders).toMatchObject([{ id, path: "/Users/mike/Documents" }]);
    const replaced = addFolder(first, "read", input("/Users/mike/Docs", "other-inode"));
    if (!replaced.ok) throw new Error("expected ok");
    expect(replaced.id).toBe(id);
    expect(replaced.state.folders).toHaveLength(1);
    expect(
      folderDigest("d1", replaced.state.folders[0] as LocalFilesState["folders"][number]),
    ).not.toBe(folderDigest("d1", first.folders[0] as LocalFilesState["folders"][number]));
  });

  test("keep-out entries are deduplicated and removable like folders", () => {
    const outcome = addKeepOut(EMPTY_LOCAL_FILES, input("/Users/mike/Private"));
    if (!outcome.ok) throw new Error("expected ok");
    const twice = addKeepOut(outcome.state, input("/Users/mike/private"));
    expect(twice).toMatchObject({ ok: true, id: outcome.id });
    const withFolder = added(outcome.state, "/Users/mike/Docs");
    const view = allowancesView(withFolder);
    expect(view.items.map((item) => item.kind)).toEqual(["folder", "keep_out"]);
    const removed = removeAllowance(withFolder, outcome.id);
    expect(removed.keep_out).toEqual([]);
    expect(removeAllowance(removed, removed.folders[0]?.id as string).folders).toEqual([]);
  });

  test("the runner id is remembered per server", () => {
    expect(setRunnerId(EMPTY_LOCAL_FILES, "https://a.example", "r1").runner_ids).toEqual({
      "https://a.example": "r1",
    });
  });

  test("folder digests use the P0 root digest material", () => {
    const folder = { path: "/Users/mike/Docs", volume_id: "1", file_id: "2" };
    expect(folderDigest("d1", folder)).toBe(
      sha256Hex(
        rootDigestMaterial({
          device_id: "d1",
          real_path: folder.path,
          volume_id: "1",
          file_id: "2",
        }),
      ),
    );
    expect(folderDigest("d1", folder)).not.toBe(folderDigest("d1", { ...folder, file_id: "3" }));
    expect(folderDigest("d1", folder)).not.toBe(folderDigest("d2", folder));
  });

  test("the wire list matches the engine schema and mirrors folders whatever the personal switch says", () => {
    let state = added(EMPTY_LOCAL_FILES, "/Users/mike/Docs");
    const keep = addKeepOut(state, input("/Users/mike/Private"));
    if (!keep.ok) throw new Error("expected ok");
    state = keep.state;
    expect(wireAllowances("d1", state)).toEqual(
      wireAllowances("d1", setPersonalEnabled(state, true)),
    );
    const wire = wireAllowances("d1", state);
    for (const item of wire) expect(DeviceAllowanceSchema.parse(item)).toEqual(item);
    expect(wire.map((item) => item.kind)).toEqual(["folder", "keep_out"]);
    expect(wire[0]).toMatchObject({ display: "~/Docs" });
    expect(wire[1]).toMatchObject({ display: "/Users/mike/Private" });
  });

  test("the allowances digest is order-independent and changes with any allowance", () => {
    const one = added(added(EMPTY_LOCAL_FILES, "/Users/mike/A"), "/Users/mike/B");
    const swapped = { ...one, folders: [...one.folders].reverse() };
    expect(allowancesDigest("d1", one)).toBe(allowancesDigest("d1", swapped));
    expect(allowancesDigest("d1", one)).toMatch(/^[a-f0-9]{64}$/);
    expect(allowancesDigest("d1", one)).not.toBe(
      allowancesDigest("d1", removeAllowance(one, one.folders[0]?.id as string)),
    );
    expect(allowancesDigest("d1", snapshotOf(one, env))).toBe(allowancesDigest("d1", one));
    expect(allowancesDigest("d1", one)).toBe(
      sha256Hex(allowancesDigestMaterial(wireAllowances("d1", one))),
    );
  });

  test("changing access keeps the id and root digest but changes the allowances digest", () => {
    const state = added(EMPTY_LOCAL_FILES, "/Users/mike/Docs");
    const id = state.folders[0]?.id as string;
    const wider = setFolderAccess(state, id, "write");
    if (!wider) throw new Error("expected a state");
    expect(wider.folders[0]).toMatchObject({ id, access: "write" });
    expect(folderDigest("d1", wider.folders[0] as LocalFilesState["folders"][number])).toBe(
      folderDigest("d1", state.folders[0] as LocalFilesState["folders"][number]),
    );
    expect(allowancesDigest("d1", wider)).not.toBe(allowancesDigest("d1", state));
    expect(wireAllowances("d1", wider)[0]).toMatchObject({ access: "write" });
    expect(setFolderAccess(state, "unknown", "write")).toBeNull();
  });

  test.each([
    ["available", { real_path: "/Users/mike/Docs", volume_id: "uuid:A", file_id: "7" }],
    ["changed", { real_path: "/Users/mike/Docs", volume_id: "uuid:A", file_id: "8" }],
    ["changed", { real_path: "/Users/mike/Docs", volume_id: "uuid:B", file_id: "7" }],
    ["changed", { real_path: "/Users/mike/Other", volume_id: "uuid:A", file_id: "7" }],
    ["missing", null],
  ] as const)("a folder is %s", (expected, observed) => {
    expect(
      folderStatus({ path: "/Users/mike/Docs", volume_id: "uuid:A", file_id: "7" }, observed),
    ).toBe(expected);
  });

  test("the view shows a status for folders only", () => {
    const keep = addKeepOut(added(EMPTY_LOCAL_FILES, "/Users/mike/Docs"), input("/Users/mike/P"));
    if (!keep.ok) throw new Error("expected ok");
    const id = keep.state.folders[0]?.id as string;
    const view = allowancesView(keep.state, { [id]: "changed" });
    expect(view.items.map((item) => item.status)).toEqual(["changed", null]);
    expect(allowancesView(keep.state).items[0]?.status).toBeNull();
  });

  test("display paths shorten the home folder only", () => {
    expect(displayPath("/Users/mike/Docs", "/Users/mike")).toBe("~/Docs");
    expect(displayPath("/Users/mikey/Docs", "/Users/mike")).toBe("/Users/mikey/Docs");
    expect(displayPath("/Volumes/Data/x", null)).toBe("/Volumes/Data/x");
  });
});

describe("main's guard for Trash and quarantine requests", () => {
  const base = setPersonalEnabled(
    added(added(EMPTY_LOCAL_FILES, "/Users/mike/Docs", "write"), "/Users/mike/Read"),
    true,
  );
  const keep = addKeepOut(base, input("/Users/mike/Private"));
  if (!keep.ok) throw new Error("expected ok");
  const snapshot = snapshotOf(keep.state, env);

  test.each([
    ["/Users/mike/Docs/a.txt", true],
    ["/Users/mike/Notes/a.txt", true],
    ["/Users/mike/Private/a.txt", false],
    ["/Users/mike/PRIVATE/a.txt", false],
    ["/Users/mike/Docs/.git", false],
    ["/Users/mike/Docs/id_rsa", false],
    ["/Users/mike", false],
    ["/Users/mike/Library/Application Support/SubKit/x", false],
    ["/etc/hosts", false],
    ["relative/a.txt", false],
    ["/Users/mike/Docs/.subkit-abc-1.bak", true],
    ["/Users/mike/Docs/sub/.subkit-abc-1.tmp", true],
    ["/Users/mike/Read/.subkit-abc-1.bak", false],
    ["/Users/mike/Notes/.subkit-abc-1.bak", false],
    ["/Users/mike/Docs/.git/.subkit-abc-1.bak", false],
    ["/Users/mike/Docs/.subkit-abc.bak.txt", false],
  ])("%s → %s", (path, expected) => {
    expect(mayTouch(path, snapshot, false)).toBe(expected);
  });

  test("only write folders while the personal switch is off", () => {
    const off = { ...snapshot, personal_enabled: false };
    expect(mayTouch("/Users/mike/Docs/a.txt", off, false)).toBe(true);
    expect(mayTouch("/Users/mike/Read/a.txt", off, false)).toBe(false);
    expect(mayTouch("/Users/mike/Notes/a.txt", off, false)).toBe(false);
  });
});

describe("websites and apps on this device", () => {
  const NOW = Date.parse("2026-11-21T10:00:00Z");
  const numbers = { bundle_id: "com.apple.Numbers", team_id: null, display: "Numbers" };

  test("a website is kept in its exact origin form, a private address marked", () => {
    const added = addSite(EMPTY_LOCAL_FILES, "  https://Shop.Example.com/  ", NOW);
    expect(added).toEqual({
      ok: true,
      id: "https://shop.example.com",
      state: {
        ...EMPTY_LOCAL_FILES,
        sites: [
          {
            origin: "https://shop.example.com",
            private: false,
            added_at: "2026-11-21T10:00:00.000Z",
          },
        ],
      },
    });
    const local = addSite(EMPTY_LOCAL_FILES, "http://192.168.1.4:8080", NOW);
    expect(local.ok && local.state.sites[0]).toMatchObject({
      origin: "http://192.168.1.4:8080",
      private: true,
    });
  });

  test("a path, a duplicate or a full list is refused", () => {
    expect(addSite(EMPTY_LOCAL_FILES, "https://shop.example.com/cart", NOW)).toEqual({
      ok: false,
      code: "invalid",
    });
    const once = addSite(EMPTY_LOCAL_FILES, "https://shop.example.com", NOW);
    if (!once.ok) throw new Error("expected ok");
    expect(addSite(once.state, "https://shop.example.com/", NOW)).toEqual({
      ok: false,
      code: "duplicate",
    });
    const site = once.state.sites[0];
    if (!site) throw new Error("expected a site");
    const full = {
      ...EMPTY_LOCAL_FILES,
      sites: Array.from({ length: 200 }, (_, n) => ({
        ...site,
        origin: `https://s${n}.example.com`,
      })),
    };
    expect(addSite(full, "https://new.example.com", NOW)).toEqual({ ok: false, code: "full" });
    expect(
      addSite({ ...full, sites: full.sites.slice(1) }, "https://new.example.com", NOW).ok,
    ).toBe(true);
  });

  test("an app is kept by its bundle id, a blocked app or a duplicate is refused", () => {
    const added = addApp(EMPTY_LOCAL_FILES, numbers, NOW);
    expect(added).toEqual({
      ok: true,
      id: "com.apple.Numbers",
      state: {
        ...EMPTY_LOCAL_FILES,
        apps: [{ ...numbers, added_at: "2026-11-21T10:00:00.000Z" }],
      },
    });
    if (!added.ok) throw new Error("expected ok");
    expect(addApp(added.state, numbers, NOW)).toEqual({ ok: false, code: "duplicate" });
    expect(
      addApp(
        EMPTY_LOCAL_FILES,
        { bundle_id: "com.apple.Terminal", team_id: null, display: "Terminal" },
        NOW,
      ),
    ).toEqual({ ok: false, code: "blocked_app" });
  });

  test("removing by id drops a website or an app and keeps every folder", () => {
    const folders = added(EMPTY_LOCAL_FILES, "/Users/mike/Docs");
    const kept = addKeepOut(folders, input("/Users/mike/Private"));
    if (!kept.ok) throw new Error("expected ok");
    const site = addSite(kept.state, "https://shop.example.com", NOW);
    if (!site.ok) throw new Error("expected ok");
    const both = addApp(site.state, numbers, NOW);
    if (!both.ok) throw new Error("expected ok");
    expect(removeAllowance(both.state, "https://shop.example.com")).toEqual({
      ...both.state,
      sites: [],
    });
    expect(removeAllowance(both.state, "com.apple.Numbers").apps).toEqual([]);
    expect(removeAllowance(both.state, "other")).toEqual(both.state);
  });

  test("the wire list carries websites and apps with their digests", () => {
    const site = addSite(EMPTY_LOCAL_FILES, "https://shop.example.com", NOW);
    if (!site.ok) throw new Error("expected ok");
    const both = addApp(site.state, numbers, NOW);
    if (!both.ok) throw new Error("expected ok");
    const wire = wireAllowances("d1", { ...snapshotOf(both.state, env), ...both.state });
    expect(wire).toEqual([
      {
        kind: "site",
        id: "https://shop.example.com",
        origin: "https://shop.example.com",
        private: false,
        digest: sha256Hex(
          siteDigestMaterial({
            device_id: "d1",
            origin: "https://shop.example.com",
            private: false,
          }),
        ),
        entered_by: "person",
      },
      {
        kind: "app",
        id: "com.apple.Numbers",
        display: "Numbers",
        digest: appDigest("d1", numbers),
        entered_by: "person",
      },
    ]);
    for (const item of wire) expect(DeviceAllowanceSchema.parse(item)).toEqual(item);
    expect(wireAllowances("d1", snapshotOf(both.state, env))).toEqual([]);
  });

  test("the view lists websites and apps between folders and keep-out", () => {
    const folders = added(EMPTY_LOCAL_FILES, "/Users/mike/Docs");
    const kept = addKeepOut(folders, input("/Users/mike/Private"));
    if (!kept.ok) throw new Error("expected ok");
    const site = addSite(kept.state, "http://192.168.1.4", NOW);
    if (!site.ok) throw new Error("expected ok");
    const both = addApp(site.state, numbers, NOW);
    if (!both.ok) throw new Error("expected ok");
    const items = allowancesView(both.state).items;
    expect(items.map((item) => [item.kind, item.private])).toEqual([
      ["folder", false],
      ["site", true],
      ["app", false],
      ["keep_out", false],
    ]);
    expect(items.slice(1, 3)).toEqual([
      {
        id: "http://192.168.1.4",
        kind: "site",
        display: "http://192.168.1.4",
        access: null,
        status: null,
        private: true,
      },
      {
        id: "com.apple.Numbers",
        kind: "app",
        display: "Numbers",
        access: null,
        status: null,
        private: false,
      },
    ]);
  });

  test("computer use needs the helper, the switch only opens it to chat and tasks", () => {
    const app = addApp(EMPTY_LOCAL_FILES, numbers, NOW);
    if (!app.ok) throw new Error("expected ok");
    const helper = { path: "/Applications/SubKit.app/h", state_root: "/Users/mike/state" };
    expect(computerOf(setPersonalEnabled(app.state, true), helper)).toEqual({
      enabled: true,
      personal_enabled: true,
      apps: [numbers],
      keep_out: [],
      helper,
    });
    expect(computerOf(app.state, helper)).toMatchObject({ enabled: true, personal_enabled: false });
    expect(computerOf(setPersonalEnabled(app.state, true), null).enabled).toBe(false);
  });

  test("stored allowances from before websites and apps read as empty lists", () => {
    const { sites: _s, apps: _a, ...older } = EMPTY_LOCAL_FILES;
    expect(parseLocalFiles(older)).toEqual(EMPTY_LOCAL_FILES);
  });
});
