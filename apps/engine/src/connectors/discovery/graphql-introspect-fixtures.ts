import { type mock, test } from "bun:test";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";

export const SAMPLE_SCHEMA = {
  data: {
    __schema: {
      queryType: { name: "Query" },
      mutationType: { name: "Mutation" },
      subscriptionType: null,
      types: [
        {
          kind: "OBJECT",
          name: "Query",
          interfaces: [],
          fields: [
            {
              name: "viewer",
              description: "The currently authenticated user.",
              args: [],
              type: { kind: "OBJECT", name: "User", ofType: null },
              isDeprecated: false,
            },
            {
              name: "repository",
              description: "Look up a repository by owner and name.",
              args: [
                {
                  name: "owner",
                  type: {
                    kind: "NON_NULL",
                    name: null,
                    ofType: { kind: "SCALAR", name: "String", ofType: null },
                  },
                },
                {
                  name: "name",
                  type: {
                    kind: "NON_NULL",
                    name: null,
                    ofType: { kind: "SCALAR", name: "String", ofType: null },
                  },
                },
              ],
              type: { kind: "OBJECT", name: "Repository", ofType: null },
              isDeprecated: false,
            },
          ],
        },
        {
          kind: "OBJECT",
          name: "Mutation",
          interfaces: [],
          fields: [
            {
              name: "createIssue",
              description: "Open a new issue against a repository.",
              args: [
                {
                  name: "input",
                  type: {
                    kind: "NON_NULL",
                    name: null,
                    ofType: { kind: "INPUT_OBJECT", name: "CreateIssueInput", ofType: null },
                  },
                },
              ],
              type: { kind: "OBJECT", name: "CreateIssuePayload", ofType: null },
              isDeprecated: false,
            },
          ],
        },
        {
          kind: "OBJECT",
          name: "User",
          interfaces: [],
          fields: [
            {
              name: "login",
              args: [],
              type: {
                kind: "NON_NULL",
                name: null,
                ofType: { kind: "SCALAR", name: "String", ofType: null },
              },
              isDeprecated: false,
            },
          ],
        },
        {
          kind: "OBJECT",
          name: "Repository",
          interfaces: [],
          fields: [
            {
              name: "name",
              args: [],
              type: {
                kind: "NON_NULL",
                name: null,
                ofType: { kind: "SCALAR", name: "String", ofType: null },
              },
              isDeprecated: false,
            },
          ],
        },
        {
          kind: "OBJECT",
          name: "CreateIssuePayload",
          interfaces: [],
          fields: [
            {
              name: "issueId",
              args: [],
              type: { kind: "SCALAR", name: "ID", ofType: null },
              isDeprecated: false,
            },
          ],
        },
        {
          kind: "INPUT_OBJECT",
          name: "CreateIssueInput",
          inputFields: [
            {
              name: "repositoryId",
              type: {
                kind: "NON_NULL",
                name: null,
                ofType: { kind: "SCALAR", name: "ID", ofType: null },
              },
            },
            {
              name: "title",
              type: {
                kind: "NON_NULL",
                name: null,
                ofType: { kind: "SCALAR", name: "String", ofType: null },
              },
            },
          ],
        },
        { kind: "SCALAR", name: "String" },
        { kind: "SCALAR", name: "ID" },
      ],
      directives: [],
    },
  },
};

export function graphqlIntrospectFixtures(state: {
  readonly fetchSpy: ReturnType<typeof mock<typeof fetch>>;
}) {
  function seamTest(name: string, body: () => Promise<void>) {
    test(name, () =>
      withSelfHostedDriverFetchForTests(state.fetchSpy as unknown as typeof fetch, body),
    );
  }

  return { seamTest };
}
