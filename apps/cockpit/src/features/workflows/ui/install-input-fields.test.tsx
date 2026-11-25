import { expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { InstallInputFields } from "./install-input-fields";

const fields = [{ key: "property_id", label: "GA4 property id (digits only)", list: false }];

test("a host list install input is one host per line with the host hint (#895)", () => {
  const hosts = [{ key: "allowed_hosts", label: "Allowed hosts", list: true }];
  const value = "docs.example.com\nexample.com";
  const markup = render(
    <InstallInputFields fields={hosts} values={{ allowed_hosts: value }} onChange={() => {}} />,
    "de",
  );
  expect(markup).toContain("<textarea");
  expect(markup).toContain('id="create-solution-input-allowed_hosts"');
  expect(markup).toContain(value);
  expect(markup).toContain("Ein Host pro Zeile, etwa docs.example.com.");
});

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
