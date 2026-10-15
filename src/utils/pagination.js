const encodeCursor = (id) => Buffer.from(String(id), "utf-8").toString("base64");
const decodeCursor = (cursor) => Buffer.from(cursor, "base64").toString("utf-8");

export const paginate = (items, { first, after } = {}) => {
  let startIndex = 0;
  if (after) {
    const afterId = decodeCursor(after);
    const afterIndex = items.findIndex((item) => String(item.id) === afterId);
    startIndex = afterIndex === -1 ? items.length : afterIndex + 1;
  }
  const pageSize = first ?? items.length - startIndex;
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
