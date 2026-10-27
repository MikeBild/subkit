import { expect, test } from "bun:test";
import { prepareMultipartBody } from "../../connectors/drivers/http-multipart.ts";
import {
  compileRequestBoundary,
  requestBoundaryViolation,
} from "../../workflows/request-boundary.ts";
import { RequestStepSchema } from "../../workflows/types.ts";
import { preparedRequestProof, preparedRequestReview } from "../prepared-request.ts";
import type { RequestAuthoritySnapshot } from "../types.ts";

const snapshot: RequestAuthoritySnapshot = {
  step_id: "upload",
  step_row_id: "preview",
  connector_id: null,
  requires_review: true,
  request_max_attempts: 5,
  principal_id: "operator",
  configuration_digest: "0".repeat(64),
  credential_id: null,
  credential_revision: null,
  connection_authority: null,
};
const placeholder = (name: string) => `$\u007b${name}}`;

test("multipart authority measures transmitted bytes and binds file content without exposing it", async () => {
  const form = new FormData();
  form.append("name", "fixture");
  form.append("file", new Blob(["private-binary-content"]), "data.bin");
  const prepared = await prepareMultipartBody(form);
  const decoded = await new Response(prepared.body, {
    headers: { "content-type": prepared.contentType },
  }).formData();
  expect(await (decoded.get("file") as File).text()).toBe("private-binary-content");
  expect(prepared.observation.body_bytes).toBe(prepared.body.byteLength);
  expect(JSON.stringify(prepared.observation)).not.toContain("private-binary-content");
  const step = RequestStepSchema.parse({
    id: "upload",
    connector_id: "00000000-0000-4000-8000-000000000001",
    kind: "request",
    method: "PUT",
    path: `/objects/${placeholder("input.id")}`,
    multipart: [{ name: "file", file: placeholder("item.data") }],
    boundary: {
      variables: { "input.id": { class: "uuid" } },
      max_body_bytes: prepared.body.byteLength,
      max_calls: 5,
    },
  });
  const compiled = compileRequestBoundary(step, "https://files.example.test");
  expect(compiled.refusal).toBeUndefined();
  if (!compiled.boundary) throw new Error("Missing boundary");
  const request = {
    method: "PUT",
    url: "https://files.example.test/objects/00000000-0000-4000-8000-000000000001",
    headers: {},
    ...prepared.observation,
  };
  expect(requestBoundaryViolation(compiled.boundary, request)).toBeNull();
  expect(requestBoundaryViolation({ ...compiled.boundary, max_body_bytes: 1 }, request)?.kind).toBe(
    "body_size",
  );
  const { body_bytes: _bytes, ...unmeasured } = request;
  expect(requestBoundaryViolation(compiled.boundary, unmeasured)?.kind).toBe("unsupported_body");
  expect(
    requestBoundaryViolation(compiled.boundary, {
      ...request,
      url: "https://other.test/objects/id",
    })?.kind,
  ).toBe("target");
  const proof = preparedRequestProof("tenant", snapshot, request, 5);
  expect(proof).not.toBeNull();
  const replay = await prepareMultipartBody(form);
  expect(
    preparedRequestProof("tenant", snapshot, { ...request, ...replay.observation }, 5),
  ).toEqual(proof);
  form.set("file", new Blob(["changed-binary-content"]), "data.bin");
  const changed = await prepareMultipartBody(form);
  expect(
    preparedRequestProof("tenant", snapshot, { ...request, ...changed.observation }, 5),
  ).not.toEqual(proof);
  const review = preparedRequestReview(request);
  expect(review?.opaque_payload_omitted).toBe(true);
  expect(review?.body_bytes).toBe(prepared.body.byteLength);
  expect(JSON.stringify(review)).not.toContain("private-binary-content");
});

test("only a bounded idempotency header may vary; routing and authorization headers remain refused", () => {
  const step = RequestStepSchema.parse({
    id: "create",
    connector_id: "00000000-0000-4000-8000-000000000001",
    kind: "request",
    method: "POST",
    path: "/objects",
    headers: { "Idempotency-Key": placeholder("input.key") },
    boundary: {
      variables: { "input.key": { class: "identifier" } },
      max_body_bytes: 100,
      max_calls: 5,
    },
  });
  const compiled = compileRequestBoundary(step, "https://files.example.test");
  expect(compiled.refusal).toBeUndefined();
  if (!compiled.boundary) throw new Error("Missing boundary");
  const request = {
    method: "POST",
    url: "https://files.example.test/objects",
    headers: { "Idempotency-Key": "fixed-retry-key" },
    body: {},
  };
  expect(requestBoundaryViolation(compiled.boundary, request)).toBeNull();
  for (const value of ["", "x".repeat(129), "line\nbreak", "a/b"])
    expect(
      requestBoundaryViolation(compiled.boundary, {
        ...request,
        headers: { "Idempotency-Key": value },
      }),
    ).not.toBeNull();
  for (const name of ["Authorization", "Host", "X-Target", "Content-Type"])
    expect(
      compileRequestBoundary(
        { ...step, headers: { [name]: placeholder("input.key") } },
        "https://files.example.test",
      ).refusal,
    ).toBe("runtime_header");
  expect(
    compileRequestBoundary(
      { ...step, headers: { ...step.headers, "idempotency-key": "other" } },
      "https://files.example.test",
    ).refusal,
  ).toBe("runtime_header");
});
