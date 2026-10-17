import { GraphQLError } from "graphql";
import type { Connection } from "../types/models.js";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

const invalidArgument = (message: string, argument: string) =>
  new GraphQLError(message, {
    extensions: { code: "BAD_USER_INPUT", invalidArgument: argument },
  });

export const encodeCursor = (id: string): string => Buffer.from(String(id), "utf-8").toString("base64");

export const resolvePageSize = (first: number | null | undefined): number => {
  const pageSize = first ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw invalidArgument(`first must be between 1 and ${MAX_PAGE_SIZE}`, "first");
  }
  return pageSize;
};

// A cursor is the base64 of a document id. Anything that doesn't round-trip,
// or that couldn't be a Firestore id, is rejected here so it never reaches a
// query (an id with "/" would make Firestore throw instead of answering 400).
export const decodeCursor = (after: string): string => {
  const id = Buffer.from(after, "base64").toString("utf-8");
  if (!id || id.includes("/") || encodeCursor(id) !== after) {
    throw cursorNotInList();
  }
  return id;
};

// An unknown cursor used to look like "past the end" and return an empty
// page, which a client can't tell apart from a real last page.
export const cursorNotInList = () =>
  invalidArgument("after is not a cursor from this list", "after");

export const toConnection = <T extends { id: string }>(
  nodes: T[],
  pageSize: number
): Connection<T> => {
  const page = nodes.slice(0, pageSize);
  const edges = page.map((node) => ({ node, cursor: encodeCursor(node.id) }));
  return {
    edges,
    pageInfo: {
      hasNextPage: nodes.length > pageSize,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    },
  };
};
