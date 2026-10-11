import { describe, expect, test } from "bun:test";
import {
  DOMAIN_PROMPT_MAX_CHARS,
  domainsOfItem,
  domainsOfTags,
  resolveDomains,
} from "./domains.ts";

const KNOWN = ["blog-de", "ops", "radar", "mikebild-dev", "data_lake"];

describe("resolveDomains", () => {
  test("a domain matches when every part of its slug is a word of the prompt", () => {
    expect(
      resolveDomains({ prompt: "Write the next blog post, in DE please", known: KNOWN })
        .from_prompt,
    ).toEqual(["blog-de"]);
    expect(
      resolveDomains({ prompt: "Check the blog-de release order", known: KNOWN }).domains,
    ).toEqual(["blog-de"]);
    expect(resolveDomains({ prompt: "Fix the data_lake loader", known: KNOWN }).domains).toEqual([
      "data_lake",
    ]);
  });

  test("a part inside a longer word does not match", () => {
    expect(
      resolveDomains({ prompt: "DevOps pipeline and radarscope", known: KNOWN }).domains,
    ).toEqual([]);
  });

  test("the repository hint resolves on its own and both sources stay apart", () => {
    const resolved = resolveDomains({
      prompt: "page the ops on-call",
      repo_hint: "mikebild-dev",
      known: KNOWN,
    });
    expect(resolved).toEqual({
      domains: ["mikebild-dev", "ops"],
      from_prompt: ["ops"],
      from_repo: ["mikebild-dev"],
      from_folder: [],
    });
  });

  test("the result is sorted and the same for the same input", () => {
    const first = resolveDomains({
      prompt: "radar and ops and blog de",
      known: [...KNOWN].reverse(),
    });
    expect(first.domains).toEqual(["blog-de", "ops", "radar"]);
    expect(resolveDomains({ prompt: "radar and ops and blog de", known: KNOWN })).toEqual(first);
  });

  test("only the head of a long prompt is read", () => {
    const prompt = `${"x ".repeat(DOMAIN_PROMPT_MAX_CHARS)} radar`;
    expect(resolveDomains({ prompt, known: KNOWN }).domains).toEqual([]);
  });

  test("nothing to read resolves nothing", () => {
    expect(resolveDomains({ known: KNOWN })).toEqual({
      domains: [],
      from_prompt: [],
      from_repo: [],
      from_folder: [],
    });
  });

  test("the current folder matches only its normalized canonical category", () => {
    expect(
      resolveDomains({ folder_hint: "Harmoniqs", known: ["harmoniqs", "harmoniqs-app"] }),
    ).toEqual({
      domains: ["harmoniqs"],
      from_prompt: [],
      from_repo: [],
      from_folder: ["harmoniqs"],
    });
    expect(resolveDomains({ folder_hint: "harmoniqs-app", known: ["harmoniqs"] })).toEqual({
      domains: [],
      from_prompt: [],
      from_repo: [],
      from_folder: [],
    });
    expect(
      resolveDomains({ folder_hint: "/Users/example/harmoniqs", known: ["harmoniqs"] }),
    ).toEqual({ domains: [], from_prompt: [], from_repo: [], from_folder: [] });
  });
});

describe("domainsOfTags", () => {
  test("keeps only domain tags with a value", () => {
    expect(domainsOfTags(["domain:ops", "kind:guide", "domain:", "billing"])).toEqual(["ops"]);
  });
});

describe("domainsOfItem", () => {
  test("a category is a domain, beside the domain tags", () => {
    expect(domainsOfItem({ tags: ["domain:ops"], category: "radar" }).sort()).toEqual([
      "ops",
      "radar",
    ]);
    expect(domainsOfItem({ tags: ["domain:ops"], category: "ops" })).toEqual(["ops"]);
  });

  test("the uncategorised and the platform category are never domains", () => {
    expect(domainsOfItem({ tags: [], category: "other" })).toEqual([]);
    expect(domainsOfItem({ tags: ["foundations"], category: "platform" })).toEqual([]);
    expect(domainsOfItem({ tags: [], category: null })).toEqual([]);
  });
});
