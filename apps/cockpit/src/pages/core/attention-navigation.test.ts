import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  opensReviewSheet,
  reviewAccess,
  reviewForward,
  reviewSettles,
  reviewTarget,
} from "./attention-navigation";

const workflowId = "00000000-0000-4000-8000-000000000001";
const reviewHref = (href: string) => href.includes("review=");

test("review targets and permissions classify only supported review subjects", () => {
  expect(reviewTarget(`workflow:${workflowId}`)).toEqual({ kind: "workflow", workflowId });
  expect(reviewTarget("skills")).toEqual({ kind: "skills" });
  expect(reviewTarget("workflow:bad")).toEqual({ kind: "other" });
  expect(reviewAccess(reviewTarget(`workflow:${workflowId}`), ["workflow:read"])).toBe("readable");
  expect(reviewAccess(reviewTarget("skills"), [])).toBe("not_permitted");
  expect(reviewAccess(reviewTarget("connector:x"), ["connector:read"])).toBe("nothing");
});

test("review forwarding and sheet opening preserve the action reference", () => {
  const workflow = Object.freeze({ id: `workflow:${workflowId}` });
  const review = Object.freeze({ verb: "review", href: "/cockpit?review=workflow" });
  const external = Object.freeze({ verb: "review", href: "/cockpit?review=intake" });
  const chat = Object.freeze({ verb: "chat", href: "/cockpit/chat" });
  expect(opensReviewSheet(workflow, review, reviewHref)).toBe(true);
  expect(opensReviewSheet({ id: "connector:x" }, external, reviewHref)).toBe(true);
  expect(opensReviewSheet({ id: "connector:x" }, { verb: "open", href: "/x" }, reviewHref)).toBe(
    false,
  );
  expect(opensReviewSheet({ id: "connector:x" }, { verb: "review" }, reviewHref)).toBe(false);
  expect(reviewForward(review, "nothing", reviewHref)).toBeNull();
  expect(reviewForward(external, "nothing", reviewHref)).toBeNull();
  expect(reviewForward(review, "readable", reviewHref)).toBeNull();
  expect(reviewForward(chat, "nothing", reviewHref)).toBe(chat);
  expect(reviewForward({ verb: "review", href: "/x" }, "nothing", reviewHref)).toEqual({
    verb: "review",
    href: "/x",
  });
  expect(reviewForward({ verb: "review" }, "nothing", reviewHref)).toBeNull();
  expect(reviewForward(null, "readable", reviewHref)).toBeNull();
});

test("review settlement is total and does not mutate readonly facts", () => {
  fc.assert(
    fc.property(
      fc.option(fc.integer({ min: -1, max: 5 }), { nil: null }),
      fc.integer({ min: 0, max: 5 }),
      fc.boolean(),
      fc.boolean(),
      (openBefore, openNow, listedBefore, listedNow) => {
        const facts = Object.freeze({ openBefore, openNow, listedBefore, listedNow });
        const before = JSON.stringify(facts);
        expect(reviewSettles(facts)).toBe(
          openNow === 0 &&
            ((openBefore !== null && openBefore > 0) || (listedBefore && !listedNow)),
        );
        expect(JSON.stringify(facts)).toBe(before);
      },
    ),
    { seed: 20261109, numRuns: 100 },
  );
});
