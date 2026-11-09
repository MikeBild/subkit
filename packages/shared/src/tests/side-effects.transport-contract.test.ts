import { expect, test } from "bun:test";
import { Source } from "graphql";
import {
  classifyGraphqlOverHttp,
  classifyHttpSideEffect,
  graphqlOverHttpRequest,
} from "../side-effects.ts";

const query = "query { viewer { id } }";
const request = { method: "POST", body: { query } };

test("versioned absolute GraphQL targets retain their own origin", () => {
  for (const target of ["http://api.example/graphql/v12", "https://api.example/graphql/v12"])
    expect(
      graphqlOverHttpRequest({ ...request, baseUrl: "https://rest.example/api", target }),
    ).toEqual({
      endpoint: true,
      documents: [query],
    });
  expect(
    graphqlOverHttpRequest({ ...request, target: "/proxy/https://api.example/graphql/v12" }),
  ).toEqual({
    endpoint: false,
    documents: [query],
  });
});

test("relative versioned endpoints normalize all joining slashes and surrounding whitespace", () => {
  for (const baseUrl of [
    "https://api.example",
    "https://api.example///",
    " https://api.example/// ",
  ])
    for (const target of ["graphql/v12", "/graphql/v12", "///graphql/v12", "  ///graphql/v12  "])
      expect(graphqlOverHttpRequest({ ...request, baseUrl, target })).toEqual({
        endpoint: true,
        documents: [query],
      });
});

test("relative proxy paths retain interior separators and embedded protocol text", () => {
  for (const target of ["proxy/graphql", "proxy/https://api.example/graphql"])
    expect(graphqlOverHttpRequest({ ...request, target })).toEqual({
      endpoint: true,
      documents: [query],
    });
});

test("only a leading origin placeholder is stripped from a relative target", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored connector placeholder
  expect(graphqlOverHttpRequest({ ...request, target: "${connector.origin}/graphql/v12" })).toEqual(
    {
      endpoint: true,
      documents: [query],
    },
  );
  // biome-ignore lint/suspicious/noTemplateCurlyInString: unresolved interior placeholder
  expect(graphqlOverHttpRequest({ ...request, target: "/${connector.origin}graphql/v12" })).toEqual(
    {
      endpoint: false,
      documents: [query],
    },
  );
});

test("serialized GraphQL bodies are parsed and malformed batches fail closed", () => {
  expect(
    graphqlOverHttpRequest({ method: "POST", target: "/graphql", body: JSON.stringify({ query }) }),
  ).toEqual({
    endpoint: true,
    documents: [query],
  });
  for (const body of [[{ query }, null], [{ query }, 42], "not json"])
    expect(graphqlOverHttpRequest({ method: "POST", target: "/graphql", body })).toEqual({
      endpoint: true,
      documents: [],
    });
  expect(
    graphqlOverHttpRequest({ method: "POST", target: "/graphql", body: { query: 42 } }),
  ).toEqual({
    endpoint: true,
    documents: [null],
  });
});

test("GraphQL HTTP query values must be strings even when another parser accepts the value", () => {
  for (const value of [new Source(query), [query]])
    expect(
      graphqlOverHttpRequest({ method: "POST", target: "/rest", body: { query: value } }),
    ).toBeNull();
});

test("runtime placeholders in otherwise valid GraphQL documents cannot be classified as reads", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: runtime-authored workflow input
  const dynamicQuery = 'query { viewer(login: "${input.login}") { id } }';
  expect(
    classifyGraphqlOverHttp({ method: "POST", target: "/graphql", body: { query: dynamicQuery } }),
  ).toBe("write");
  expect(
    classifyGraphqlOverHttp({ method: "POST", target: "/graphql", body: { query: null } }),
  ).toBe("write");
});

test("S3 metadata and omitted-method reads retain their read classification", () => {
  expect(classifyHttpSideEffect({ s3: true, method: "HEAD" })).toBe("read");
  expect(classifyHttpSideEffect({ s3: true })).toBe("read");
  expect(classifyHttpSideEffect({ s3: true, override: "read" })).toBe("read");
});
