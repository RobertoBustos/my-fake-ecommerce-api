import { GraphQLError } from "graphql";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

const encodeCursor = (id) => Buffer.from(String(id), "utf-8").toString("base64");
const decodeCursor = (cursor) => Buffer.from(cursor, "base64").toString("utf-8");

const invalidArgument = (message, argument) =>
  new GraphQLError(message, {
    extensions: { code: "BAD_USER_INPUT", invalidArgument: argument },
  });

// Pages over a list that is already in memory: the queries still read the
// whole collection from Firestore and cut it here. Moving the limit and the
// cursor into the Firestore query is a future improvement.
export const paginate = (items, { first, after } = {}) => {
  const pageSize = first ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw invalidArgument(`first must be between 1 and ${MAX_PAGE_SIZE}`, "first");
  }

  let startIndex = 0;
  if (after != null) {
    const afterId = decodeCursor(after);
    const afterIndex = items.findIndex((item) => String(item.id) === afterId);
    // An unknown cursor used to look like "past the end" and return an empty
    // page, which a client can't tell apart from a real last page.
    if (afterIndex === -1) {
      throw invalidArgument("after is not a cursor from this list", "after");
    }
    startIndex = afterIndex + 1;
  }

  const page = items.slice(startIndex, startIndex + pageSize);
  const edges = page.map((node) => ({ node, cursor: encodeCursor(node.id) }));
  return {
    edges,
    pageInfo: {
      hasNextPage: startIndex + pageSize < items.length,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    },
  };
};
