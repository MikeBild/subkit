function require(condition, message) {
  if (!condition) throw new Error(message);
}

async function transform(route, mockApi, change) {
  await mockApi({
    request: () => route.request(),
    fulfill: async (response) => {
      require(response.status === 200 &&
        typeof response.body === "string", "people fixture failed");
      await route.fulfill({
        ...response,
        body: JSON.stringify(change(JSON.parse(response.body))),
      });
    },
  });
}

export async function verifyPeopleDisplayName(page, stand, mockApi) {
  const people = [];
  const updates = [];
  const patchRequests = [];
  const creates = [];
  let listReads = 0;
  await page.route("**/v1/identity/users**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "POST" && path === "/v1/identity/users") {
      const input = request.postDataJSON();
      creates.push(input);
      const person = {
        id: "018f4b4a-6d33-7b3a-9c2d-0000000000b3",
        email: input.email,
        display_name: input.display_name ?? null,
        role: input.role,
        status: "invited",
      };
      people.push(person);
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(person),
      });
    }
    if (request.method() === "POST" && /^\/v1\/identity\/users\/[^/]+\/invites$/.test(path)) {
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          plaintext_token: "invite_fixture_token",
          expires_at: "2026-10-11T12:00:00.000Z",
        }),
      });
    }
    if (request.method() === "PATCH") {
      patchRequests.push({ method: request.method(), path });
      const id = path.split("/").at(-1);
      const person = people.find((item) => item.id === id);
      require(person, "display-name update targeted an unknown person");
      const update = request.postDataJSON();
      updates.push(update);
      person.display_name = update.display_name;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(person),
      });
    }
    if (request.method() !== "GET" || path !== "/v1/identity/users") return route.fallback();
    listReads += 1;
    await transform(route, mockApi, (body) => {
      if (people.length === 0) {
        people.push(
          ...[
            {
              ...body.items[0],
              id: "018f4b4a-6d33-7b3a-9c2d-0000000000b1",
              email: "zoe@example.test",
              display_name: "Zoe Example",
              role: "member",
              status: "active",
            },
            {
              ...body.items[1],
              id: "018f4b4a-6d33-7b3a-9c2d-0000000000b2",
              email: "legacy@example.test",
              display_name: null,
              role: "member",
              status: "active",
            },
          ],
        );
      }
      return { ...body, items: people, total: people.length };
    });
  });
  await stand.visit(page, "people");
  const named = page.getByTestId("people-name-0").filter({ visible: true }).first();
  require((await named.innerText()) ===
    "Zoe Example\nzoe@example.test", "named person must show name then email on separate lines");
  const legacy = page.getByTestId("people-name-1").filter({ visible: true }).first();
  require((await legacy.innerText()) ===
    "legacy@example.test", "legacy null display name must show only the email");

  await page.getByTestId("people-create").filter({ visible: true }).click();
  const createDialog = page.getByTestId("people-create-dialog");
  await createDialog.waitFor({ state: "visible" });
  await createDialog.getByTestId("people-create-display-name").fill("Amelia New User");
  await createDialog.getByTestId("people-create-email").fill("amelia@example.test");
  await createDialog.getByTestId("people-create-dialog-submit").click();
  const secretDialog = page.getByTestId("secret-dialog");
  await secretDialog.waitFor({ state: "visible" });
  require(creates.length === 1 &&
    creates[0].email === "amelia@example.test" &&
    creates[0].display_name === "Amelia New User" &&
    creates[0].role === "member", "create form did not submit the provided name and email");
  await secretDialog.getByTestId("secret-dialog-submit").click();
  const search = page.getByTestId("people-search");
  await search.fill("Amelia New User");
  const created = page.getByTestId("people-name-0").filter({ visible: true }).first();
  await created.waitFor({ state: "visible" });
  require((await created.innerText()) ===
    "Amelia New User\namelia@example.test", "created user row must show name then email on separate lines");

  await search.fill("Zoe Example");
  const namedListRow = page.getByTestId("people-name-0").filter({ visible: true }).first();
  require((await namedListRow.innerText()) ===
    "Zoe Example\nzoe@example.test", "named user list row changed before editing");
  require((
    await page.getByTestId("people-name-0").filter({ visible: true }).first().innerText()
  ).includes("Zoe Example"), "search by display name failed");
  require((await page.getByTestId("people-name-1").filter({ visible: true }).count()) ===
    0, "display-name search retained unrelated person");
  await search.fill("legacy@example.test");
  require((
    await page.getByTestId("people-name-0").filter({ visible: true }).first().innerText()
  ).includes("legacy@example.test"), "search by email failed");
  require((await page.getByTestId("people-name-1").filter({ visible: true }).count()) ===
    0, "email search retained unrelated person");

  await search.fill("");
  await page.getByTestId("people-list-row-link-0").filter({ visible: true }).click();
  const nameInput = page.getByTestId("people-display-name");
  const saveName = page.getByTestId("people-display-name-save");
  await nameInput.fill("Zoe Renamed");
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="people-display-name-save"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await saveName.click();
  require(updates[0]?.display_name === "Zoe Renamed", "editing display name did not persist");
  require(patchRequests[0]?.method === "PATCH" &&
    patchRequests[0]?.path ===
      "/v1/identity/users/018f4b4a-6d33-7b3a-9c2d-0000000000b1", "editing display name targeted an unexpected identity route");
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-testid="people-display-name-save"]');
    return !root;
  });
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="people-name-0"]')?.textContent?.includes("Zoe Renamed"),
  );
  require((await page
    .getByTestId("people-name-0")
    .filter({ visible: true })
    .first()
    .innerText()) ===
    "Zoe Renamed\nzoe@example.test", "edited display name did not refresh the list row");
  const readsAfterEdit = listReads;
  await page.reload();
  await page.getByTestId("people-name-0").filter({ visible: true }).waitFor({ state: "visible" });
  require(listReads > readsAfterEdit, "edited display name was not reloaded from the people API");
  await search.fill("Zoe Renamed");
  require((await page
    .getByTestId("people-name-0")
    .filter({ visible: true })
    .first()
    .innerText()) ===
    "Zoe Renamed\nzoe@example.test", "edited display name did not survive an explicit reload");
  await search.fill("");
  await page.getByTestId("people-list-row-link-0").filter({ visible: true }).click();
  const reloadedNameInput = page.getByTestId("people-display-name");
  require((await reloadedNameInput.inputValue()) ===
    "Zoe Renamed", "reloaded people detail did not use the persisted display name");
  const reloadedSaveName = page.getByTestId("people-display-name-save");
  await reloadedSaveName.waitFor({ state: "detached" });
  const sheet = page.getByTestId("people-sheet");
  const renamedSheet = await sheet.innerText();
  require(renamedSheet.includes("Zoe Renamed"), "saved display name is not shown in the sheet");
  require(renamedSheet.includes("zoe@example.test"), "saved display name lost the email");
  await reloadedNameInput.fill("");
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="people-display-name-save"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await reloadedSaveName.click();
  require(updates[1]?.display_name === null, "clearing display name did not persist null");
  require(patchRequests[1]?.method === "PATCH" &&
    patchRequests[1]?.path ===
      "/v1/identity/users/018f4b4a-6d33-7b3a-9c2d-0000000000b1", "clearing display name targeted an unexpected identity route");
  await reloadedSaveName.waitFor({ state: "detached" });
  const clearedSheet = await sheet.innerText();
  require(clearedSheet.includes(
    "zoe@example.test",
  ), "cleared display name did not fall back to email");
  require(!clearedSheet.includes(
    "Zoe Renamed",
  ), "cleared display name remains visible in the sheet");
  await page.getByTestId("people-sheet-close").click();
  await search.fill("Zoe");
  require((await page
    .getByTestId("people-name-0")
    .filter({ visible: true })
    .first()
    .innerText()) ===
    "zoe@example.test", "cleared name did not refresh to the email-only list row");
  const readsAfterClear = listReads;
  await page.reload();
  await page.getByTestId("people-name-0").filter({ visible: true }).waitFor({ state: "visible" });
  require(listReads > readsAfterClear, "cleared display name was not reloaded from the people API");
  await search.fill("zoe@example.test");
  require((await page
    .getByTestId("people-name-0")
    .filter({ visible: true })
    .first()
    .innerText()) ===
    "zoe@example.test", "cleared display name did not survive an explicit reload");
}
