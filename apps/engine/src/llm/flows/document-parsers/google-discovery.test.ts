import { describe, expect, it } from "bun:test";

import {
  listGoogleDiscoveryMethods,
  parseGoogleDiscovery,
  parseGoogleDiscoveryDocument,
  parseGoogleDiscoveryWithMetadata,
} from "./google-discovery.ts";

const FIRESTORE_DISCOVERY = JSON.stringify({
  kind: "discovery#restDescription",
  protocol: "rest",
  name: "firestore",
  title: "Cloud Firestore API",
  version: "v1",
  rootUrl: "https://firestore.googleapis.com/",
  servicePath: "",
  auth: {
    oauth2: {
      scopes: {
        "https://www.googleapis.com/auth/datastore": {
          description: "View and manage your Google Cloud Datastore data",
        },
      },
    },
  },
  parameters: {
    key: { type: "string", location: "query", description: "API key" },
    quotaUser: { type: "string", location: "query" },
  },
  schemas: {
    Document: { id: "Document", type: "object", properties: { name: { type: "string" } } },
    ListDocumentsResponse: {
      id: "ListDocumentsResponse",
      type: "object",
      properties: { documents: { type: "array", items: { $ref: "Document" } } },
    },
  },
  resources: {
    projects: {
      resources: {
        databases: {
          resources: {
            documents: {
              methods: {
                get: {
                  id: "firestore.projects.databases.documents.get",
                  path: "v1/{+name}",
                  flatPath:
                    "v1/projects/{projectsId}/databases/{databasesId}/documents/{documentsId}",
                  httpMethod: "GET",
                  description: "Gets a single document.",
                  parameters: {
                    name: { type: "string", location: "path", required: true },
                    mask_fieldPaths: {
                      type: "string",
                      location: "query",
                      repeated: true,
                    },
                  },
                  response: { $ref: "Document" },
                  scopes: ["https://www.googleapis.com/auth/datastore"],
                },
                list: {
                  id: "firestore.projects.databases.documents.list",
                  path: "v1/{+parent}/{collectionId}",
                  httpMethod: "GET",
                  parameters: {
                    parent: { type: "string", location: "path", required: true },
                    collectionId: { type: "string", location: "path", required: true },
                    pageSize: {
                      type: "integer",
                      format: "int32",
                      location: "query",
                    },
                  },
                  response: { $ref: "ListDocumentsResponse" },
                },
              },
            },
          },
        },
      },
    },
  },
});

describe("Google Discovery parser", () => {
  it("rejects JSON that is not a REST Discovery document", () => {
    expect(() => parseGoogleDiscoveryDocument('{"openapi":"3.0.3"}')).toThrow(
      "not a Google REST Discovery",
    );
  });

  it("recurses through nested resources and preserves method ids", () => {
    const methods = listGoogleDiscoveryMethods(parseGoogleDiscoveryDocument(FIRESTORE_DISCOVERY));
    expect(methods.map((entry) => entry.id)).toEqual([
      "firestore.projects.databases.documents.get",
      "firestore.projects.databases.documents.list",
    ]);
  });

  it("extracts base URL, OAuth auth, endpoints, and referenced schemas", () => {
    const parsed = parseGoogleDiscoveryWithMetadata(FIRESTORE_DISCOVERY);
    expect(parsed.base_url).toBe("https://firestore.googleapis.com");
    expect(parsed.auth_hint).toEqual({ type: "oauth2" });
    expect(parsed.title).toBe("Cloud Firestore API");
    expect(parsed.version).toBe("v1");
    expect(parsed.endpoints).toHaveLength(2);

    const get = parsed.endpoints[0]!;
    expect(get).toMatchObject({
      method: "GET",
      path: "/v1/projects/{projectsId}/databases/{databasesId}/documents/{documentsId}",
      idempotent: true,
      response_schema: { id: "Document", type: "object" },
    });
    expect(get.query_schema).toMatchObject({
      type: "object",
      properties: {
        key: { type: "string" },
        quotaUser: { type: "string" },
        mask_fieldPaths: { type: "array", items: { type: "string" } },
      },
    });
  });

  it("normalizes reserved expansion paths when flatPath is absent", () => {
    const endpoints = parseGoogleDiscovery(FIRESTORE_DISCOVERY);
    expect(endpoints[1]?.path).toBe("/v1/{parent}/{collectionId}");
  });

  it("detects API-key query auth when OAuth scopes are absent", () => {
    const apiKeyDoc = JSON.stringify({
      kind: "discovery#restDescription",
      protocol: "rest",
      rootUrl: "https://example.googleapis.com/",
      servicePath: "v1/",
      parameters: { key: { type: "string", location: "query" } },
      resources: {},
    });
    const parsed = parseGoogleDiscoveryWithMetadata(apiKeyDoc);
    expect(parsed.base_url).toBe("https://example.googleapis.com/v1");
    expect(parsed.auth_hint).toEqual({ type: "query", query_param: "key" });
  });
});
