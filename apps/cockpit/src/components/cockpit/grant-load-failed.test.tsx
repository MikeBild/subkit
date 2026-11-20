import { expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { GrantLoadFailed } from "./grant-load-failed";

test("an approval that could not be loaded says that nothing changed and offers to try again", () => {
  const de = render(<GrantLoadFailed onRetry={() => {}} />);
  expect(de).toContain('data-testid="authority-load-failed"');
  expect(de).toContain("Die Freigabe konnte nicht geladen werden. Nichts wurde geändert.");
  expect(de).toContain('data-testid="authority-load-failed-retry"');
  expect(de).toContain("Erneut versuchen");
  const en = render(<GrantLoadFailed onRetry={() => {}} />, "en");
  expect(en).toContain("The approval could not be loaded. Nothing was changed.");
  expect(en).toContain("Try again");
});
