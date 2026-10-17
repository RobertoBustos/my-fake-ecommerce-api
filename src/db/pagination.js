import { FieldPath } from "firebase-admin/firestore";
import {
  cursorNotInList,
  decodeCursor,
  resolvePageSize,
  toConnection,
} from "../utils/pagination.js";

// Pages inside Firestore instead of reading the whole collection: a stable
// order by document id, startAfter the cursor and one extra document to know
// whether there is a next page. A page costs at most first + 1 reads, plus
// one to check the cursor.
export const paginateQuery = async (query, { first, after } = {}, toNode) => {
  const pageSize = resolvePageSize(first);
  let pageQuery = query.orderBy(FieldPath.documentId());

  if (after != null) {
    const afterId = decodeCursor(after);
    // Same filters as the list, so a cursor from another list (or another
    // user's orders) is rejected rather than silently used as a position.
    const cursorDoc = await query.where(FieldPath.documentId(), "==", afterId).limit(1).get();
    if (cursorDoc.empty) {
      throw cursorNotInList();
    }
    pageQuery = pageQuery.startAfter(afterId);
  }

  const snapshot = await pageQuery.limit(pageSize + 1).get();
  return toConnection(snapshot.docs.map(toNode), pageSize);
};
