import { performance } from "node:perf_hooks";
import type { ApolloServerPlugin } from "@apollo/server";
import { getOperationAST, Kind, type DocumentNode, type OperationDefinitionNode, type SelectionSetNode } from "graphql";
import { logger } from "#src/utils/logger.js";
import { boundedLabel, metrics } from "./metrics.js";
import { nameRequestSpan } from "./spans.js";

// Every GraphQL request is a POST /graphql that answers 200, so Cloud Run's
// request logs can't tell a slow purchase from a fast listing. This plugin
// writes one summary line per request: which operation, which root fields,
// how long it took and which error codes it answered.
//
// Never the variables (updateOrder carries an address and a phone), the query
// text or the search text: only names the schema defines and the operation's
// own name.

// The code of an unexpected failure; every other code is the client's or retryable.
const SERVER_ERROR = "INTERNAL_SERVER_ERROR";

// The client names its operations, so the metric label is bounded: the first
// 50 distinct names per instance, then "other". Error codes come from the
// API, but are bounded too, in case a library adds its own.
const operationLabel = boundedLabel(50);
const errorCodeLabel = boundedLabel(20);

// The root fields an operation asked for, by name (aliases are the client's
// own words). Fragments at the root are followed.
const rootFieldsOf = (selectionSet: SelectionSetNode, document: DocumentNode, seen = new Set<string>()) => {
  const fields = new Set<string>();
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      fields.add(selection.name.value);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      rootFieldsOf(selection.selectionSet, document, seen).forEach((field) => fields.add(field));
    } else if (!seen.has(selection.name.value)) {
      seen.add(selection.name.value);
      const fragment = document.definitions.find(
        (definition) => definition.kind === Kind.FRAGMENT_DEFINITION && definition.name.value === selection.name.value
      );
      if (fragment?.kind === Kind.FRAGMENT_DEFINITION) {
        rootFieldsOf(fragment.selectionSet, document, seen).forEach((field) => fields.add(field));
      }
    }
  }
  return fields;
};

const describe = (operation: OperationDefinitionNode | undefined, document: DocumentNode | undefined) => ({
  operationType: operation?.operation ?? "unknown",
  rootFields: operation && document ? [...rootFieldsOf(operation.selectionSet, document)].sort() : [],
});

export const operationSummaryPlugin: ApolloServerPlugin = {
  async requestDidStart() {
    const start = performance.now();
    return {
      async willSendResponse({ request, operation: resolved, document, response }) {
        // Apollo resolves the operation only after validation passes; for a
        // document that parsed but failed validation, find it the same way,
        // so the summary still says what was asked.
        const operation = resolved ?? (document ? getOperationAST(document, request.operationName) : null) ?? undefined;
        const errors = response.body.kind === "single" ? (response.body.singleResult.errors ?? []) : [];
        // Formatted errors always carry a code (Apollo fills in
        // INTERNAL_SERVER_ERROR), so this reads what the client got.
        const errorCodes = [...new Set(errors.map((error) => String(error.extensions?.code ?? SERVER_ERROR)))].sort();
        const fields = {
          // Taken from the parsed document, never from the raw request: a
          // document that doesn't parse logs no name.
          operationName: operation?.name?.value ?? "anonymous",
          ...describe(operation, document),
          durationMs: Math.round((performance.now() - start) * 10) / 10,
          ...(errorCodes.length > 0 && { errorCodes }),
        };
        // The trace takes the operation's name too: "graphql createOrderPayment".
        nameRequestSpan(`graphql ${fields.operationName}`);
        // RED: one observation per request. An unexpected failure is the
        // error code that counts when there are several.
        metrics.record("graphql.operation.duration", fields.durationMs / 1000, {
          operation: operationLabel(fields.operationName),
          type: fields.operationType,
          error_code: errorCodeLabel(
            errorCodes.includes(SERVER_ERROR) ? SERVER_ERROR : (errorCodes[0] ?? "none")
          ),
        });
        if (errorCodes.includes(SERVER_ERROR)) {
          // The error itself is already logged with its stack
          // (errorLogging.ts); reporting the summary too would add a
          // duplicate "GraphQL operation" group to Error Reporting.
          logger.error("GraphQL operation", fields, { report: false });
        } else if (errorCodes.length > 0) {
          logger.warn("GraphQL operation", fields);
        } else {
          logger.info("GraphQL operation", fields);
        }
      },
    };
  },
};
