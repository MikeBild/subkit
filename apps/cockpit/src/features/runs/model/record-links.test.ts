import { expect, test } from "bun:test";
import { recordButtons, recordSystems, runRecordLinks, runStepTally } from "./record-links";

const link = {
  label: "acme/app#42",
  url: "https://github.com/acme/app/issues/42",
  connector: "github",
  connector_name: "GitHub",
  step_key: "create_issue",
};

test("record links are read from the run detail", () => {
  expect(runRecordLinks({ record_links: [link] })).toEqual([
    {
      label: "acme/app#42",
      url: "https://github.com/acme/app/issues/42",
      connector: "github",
      connectorName: "GitHub",
      stepKey: "create_issue",
    },
  ]);
});

test("links that are not https or lack a system are dropped", () => {
  expect(
    runRecordLinks({
      record_links: [
        { ...link, url: "http://github.com/acme" },
        { ...link, url: "javascript:alert(1)" },
        { ...link, url: "https://user:pw@github.com/acme" },
        { ...link, connector_name: 7 },
        "nope",
      ],
    }),
  ).toEqual([]);
  expect(runRecordLinks(null)).toEqual([]);
  expect(runRecordLinks({})).toEqual([]);
});

test("at most two links become buttons and systems are named once", () => {
  const links = runRecordLinks({
    record_links: [
      link,
      { ...link, url: "https://github.com/acme/app/issues/43" },
      { ...link, url: "https://www.notion.so/Plan", connector: "notion", connector_name: "Notion" },
    ],
  });
  expect(recordButtons(links)).toHaveLength(2);
  expect(recordSystems(links)).toBe("GitHub, Notion");
});

test("the step tally needs a positive total", () => {
  expect(runStepTally({ outcome: { steps: { succeeded: 2, total: 3 } } })).toEqual({
    succeeded: 2,
    total: 3,
  });
  expect(runStepTally({ outcome: { steps: { succeeded: 0, total: 0 } } })).toBeNull();
  expect(runStepTally({})).toBeNull();
});
