import { FieldPath, type DocumentSnapshot, type Query, type WriteBatch } from "firebase-admin/firestore";
import db from "../config/firestore.js";
import type { Connection, Page } from "../types/models.js";
import { paginateQuery } from "./pagination.js";

// catalog/{globalProductId}: our own copy of every product of every source,
// so listing and filtering the catalog is one query to Firestore instead of
// one per source. The catalog sync (catalog/catalogSync.ts) keeps it up to
// date; price and stock are only indicative here, and the cart and the
// payment still ask the product's source.
//
// catalogSync/{sourceKey}: where the sync of each source left off.

const COLLECTION = "catalog";
const SYNC_COLLECTION = "catalogSync";
// Firestore allows 500 writes per batch.
const BATCH_SIZE = 500;
const ID_PAGE_SIZE = 500;

export interface CatalogEntry {
  // Global product id; also the document id.
  id: string;
  sourceKey: string;
  localId: string;
  title: string;
  description: string;
  // Shared category name (catalog/categories.ts).
  category: string;
  image: string;
  // The source's own price and currency, before any conversion.
  currency: string;
  unitPrice: number;
  purchaseLimits: { min: number; max: number };
  // Units the source had at the last sync.
  available: number;
  // The product's updatedAt in its source; null when the source doesn't track it.
  sourceUpdatedAt: Date | null;
  syncedAt: Date;
}

export interface CatalogSyncState {
  // updatedAt of the latest change already in the index: the next pull asks
  // for what changed after it. null means "everything".
  since: Date | null;
  // A pull that stopped halfway: it resumes from cursor with the same
  // runSince, and pendingSince is the latest updatedAt it has written so far.
  cursor: string | null;
  runSince: Date | null;
  pendingSince: Date | null;
  lastSyncedAt: Date | null;
  lastReconciledAt: Date | null;
}

const toDate = (value: unknown): Date | null =>
  value == null ? null : value instanceof Date ? value : (value as { toDate(): Date }).toDate();

const toEntry = (doc: DocumentSnapshot): CatalogEntry => {
  const data = doc.data() as CatalogEntry;
  return {
    ...data,
    id: doc.id,
    sourceUpdatedAt: toDate(data.sourceUpdatedAt),
    syncedAt: toDate(data.syncedAt) as Date,
  };
};

const inBatches = async <T>(items: T[], write: (batch: WriteBatch, item: T) => void) => {
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const item of items.slice(i, i + BATCH_SIZE)) write(batch, item);
    await batch.commit();
  }
};

// Replaces each entry whole, so a field the source dropped doesn't linger.
export const upsertCatalogEntries = (entries: CatalogEntry[]) =>
  inBatches(entries, (batch, { id, ...entry }) => batch.set(db.collection(COLLECTION).doc(id), entry));

export const deleteCatalogEntries = (ids: string[]) =>
  inBatches(ids, (batch, id) => batch.delete(db.collection(COLLECTION).doc(id)));

export const getCatalogEntry = async (id: string) => {
  const doc = await db.collection(COLLECTION).doc(id).get();
  return doc.exists ? toEntry(doc) : null;
};

// One result per id, in the same order, null for an id the index doesn't hold.
export const getCatalogEntries = async (ids: readonly string[]): Promise<(CatalogEntry | null)[]> => {
  if (ids.length === 0) return [];
  const docs = await db.getAll(...ids.map((id) => db.collection(COLLECTION).doc(id)));
  return docs.map((doc) => (doc.exists ? toEntry(doc) : null));
};

// The products query: one page of the index, only for the given sources,
// paged by document id (the global product id) like every other list.
export const listCatalogEntries = async (
  { sourceKeys, id, category }: { sourceKeys: string[]; id?: string; category?: string },
  page: Page = {}
): Promise<Connection<CatalogEntry>> => {
  if (sourceKeys.length === 0) {
    return { edges: [], pageInfo: { hasNextPage: false, endCursor: null } };
  }
  let query: Query = db.collection(COLLECTION);
  query =
    sourceKeys.length === 1
      ? query.where("sourceKey", "==", sourceKeys[0])
      : query.where("sourceKey", "in", sourceKeys);
  if (id !== undefined) query = query.where(FieldPath.documentId(), "==", id);
  if (category !== undefined) query = query.where("category", "==", category);
  return paginateQuery(query, page, toEntry);
};

// Every id the index holds for a source, read in pages without the fields.
export const listCatalogEntryIds = async (sourceKey: string): Promise<string[]> => {
  const ids: string[] = [];
  let after: string | undefined;
  for (;;) {
    let query = db
      .collection(COLLECTION)
      .where("sourceKey", "==", sourceKey)
      .orderBy(FieldPath.documentId())
      .select()
      .limit(ID_PAGE_SIZE);
    if (after) query = query.startAfter(after);
    const snapshot = await query.get();
    ids.push(...snapshot.docs.map((doc) => doc.id));
    if (snapshot.size < ID_PAGE_SIZE) return ids;
    after = snapshot.docs[snapshot.size - 1].id;
  }
};

// Every entry of the index, of every source (switched off or not), read in
// pages: what a reconciliation copies into the search index.
export const listAllCatalogEntries = async (): Promise<CatalogEntry[]> => {
  const entries: CatalogEntry[] = [];
  let after: string | undefined;
  for (;;) {
    let query = db.collection(COLLECTION).orderBy(FieldPath.documentId()).limit(ID_PAGE_SIZE);
    if (after) query = query.startAfter(after);
    const snapshot = await query.get();
    entries.push(...snapshot.docs.map(toEntry));
    if (snapshot.size < ID_PAGE_SIZE) return entries;
    after = snapshot.docs[snapshot.size - 1].id;
  }
};

export const getCatalogSyncState = async (sourceKey: string): Promise<CatalogSyncState | null> => {
  const doc = await db.collection(SYNC_COLLECTION).doc(sourceKey).get();
  if (!doc.exists) return null;
  const data = doc.data() as Record<string, unknown>;
  return {
    since: toDate(data.since),
    cursor: (data.cursor as string | null) ?? null,
    runSince: toDate(data.runSince),
    pendingSince: toDate(data.pendingSince),
    lastSyncedAt: toDate(data.lastSyncedAt),
    lastReconciledAt: toDate(data.lastReconciledAt),
  };
};

export const saveCatalogSyncState = (sourceKey: string, state: Partial<CatalogSyncState>) =>
  db.collection(SYNC_COLLECTION).doc(sourceKey).set(state, { merge: true });
