export async function verifyLocalChatWorkspace(page, base) {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto(`${base}/cockpit/chat/new`);
  const input = page.getByTestId("chat-composer-input");
  await input.fill("Ungesendeter lokaler Entwurf bleibt erhalten.");
  await input.evaluate((element) => {
    element.dataset.retentionProbe = "original";
  });
  const mode = page.getByTestId("chat-permission-select");
  await mode.click();
  await page.locator('[data-testid^="chat-permission-"][role="option"]').last().click();
  const selectedMode = await mode.textContent();
  await page.getByTestId("chat-context-toggle").click();
  await page.locator('[data-testid="chat-context"][data-presentation="docked"]').waitFor();
  await page.locator("#chat-context-content").evaluate((element) => {
    element.dataset.retentionProbe = "original";
  });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.getByTestId("chat-context").and(page.getByRole("dialog")).waitFor();
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.locator('[data-testid="chat-context"][data-presentation="docked"]').waitFor();
  if ((await input.inputValue()) !== "Ungesendeter lokaler Entwurf bleibt erhalten.")
    throw new Error("Unsent chat draft changed after workspace presentation changed");
  if ((await input.getAttribute("data-retention-probe")) !== "original")
    throw new Error("Composer remounted when workspace presentation changed");
  if ((await mode.textContent()) !== selectedMode)
    throw new Error("Draft permission mode changed after workspace presentation changed");
  if (
    (await page.locator("#chat-context-content").getAttribute("data-retention-probe")) !==
    "original"
  )
    throw new Error("Context content remounted when workspace presentation changed");
  await input.fill("");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .locator('[data-testid="chat-context"][data-presentation="docked"]')
    .getByTestId("chat-context-close")
    .focus();
  await page.keyboard.press("Escape");
  await page
    .locator('[data-testid="chat-context"][data-presentation="docked"]')
    .waitFor({ state: "hidden" });
  if (
    !(await page
      .getByTestId("chat-context-toggle")
      .evaluate((element) => element === document.activeElement))
  )
    throw new Error("Context close did not return focus to its toggle");
  await page.reload();
  if ((await page.getByTestId("chat-context-toggle").getAttribute("aria-expanded")) !== "false")
    throw new Error("Explicit context close preference was not restored");
  await page.goto(`${base}/cockpit/chat`);
  await page.getByTestId("chat-context-toggle").waitFor();
  await page.evaluate(() => localStorage.removeItem("sk-cockpit-chat-context"));
  await page.reload();
  await page.locator('[data-testid="chat-context"][data-presentation="docked"]').waitFor();
  await page.locator("#chat-context-content").evaluate((element) => {
    window.__contextRetentionProbe = element;
    element.dataset.retentionProbe = "automatic";
  });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.getByTestId("chat-context").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.locator('[data-testid="chat-context"][data-presentation="docked"]').waitFor();
  if (
    !(await page
      .locator("#chat-context-content")
      .evaluate((element) => element === window.__contextRetentionProbe))
  )
    throw new Error("Automatic context content remounted when available space changed");
  return [
    "chat-unsent-draft-retained",
    "chat-draft-mode-retained",
    "chat-context-state-retained",
    "chat-context-close-persisted",
    "chat-context-escape-restores-focus",
    "chat-automatic-context-state-retained",
  ];
}
