import { expect, test } from "bun:test";
import { ApiError } from "@/api/client";
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

test("a failed trial run names the step and its reason", () => {
  const failed = new ApiError(
    409,
    {
      code: "authority_preparation_failed",
      message: "The preparation did not complete at step read: upstream 503",
      details: { step_id: "read", step_code: "http_503", reason: "upstream answered 503" },
    },
    null,
  );
  const en = render(<GrantLoadFailed error={failed} onRetry={() => {}} />, "en");
  expect(en).toContain("At step “read”: upstream answered 503");
  const sample = new ApiError(
    400,
    {
      code: "input_schema_violation",
      message: "$input/since: must have required property 'since'",
    },
    null,
  );
  expect(render(<GrantLoadFailed error={sample} onRetry={() => {}} />, "en")).toContain(
    "$input/since: must have required property &#x27;since&#x27;",
  );
});
