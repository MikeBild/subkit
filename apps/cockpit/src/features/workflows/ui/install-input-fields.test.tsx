import { expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { InstallInputFields } from "./install-input-fields";

const fields = [{ key: "property_id", label: "GA4 property id (digits only)" }];

test("asks for each declared install input with its schema label and the pin hint", () => {
  const markup = render(
    <InstallInputFields fields={fields} values={{ property_id: "123" }} onChange={() => {}} />,
    "en",
  );
  expect(markup).toContain('data-testid="create-solution-inputs"');
  expect(markup).toContain('id="create-solution-input-property_id"');
  expect(markup).toContain("GA4 property id (digits only)");
  expect(markup).toContain('value="123"');
  expect(markup).toContain("Fixed into the approved boundary when the workflow is created.");
});

test("renders nothing when the recipe declares no install inputs", () => {
  expect(render(<InstallInputFields fields={[]} values={{}} onChange={() => {}} />)).toBe("");
});
