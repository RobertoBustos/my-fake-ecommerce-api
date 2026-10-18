import db from "../../src/config/firestore.js";
import { withCoreReservations } from "../../src/catalog/coreReservations.js";
import { firestoreCatalogSource } from "../../src/catalog/sources/firestore/adapter.js";
import { describeCatalogSourceContract } from "./catalogSource.contract.js";
import { createMemorySource, memoryHarness } from "./memorySource.js";

// The contract against the adapters the registry serves, on the Firestore
// emulator: the Firestore source, and a source without reservations of its
// own wrapped with withCoreReservations (which keeps them in Firestore).

const deleteReservationsOf = async (localIds) => {
  for (let i = 0; i < localIds.length; i += 30) {
    const snapshot = await db
      .collection("reservations")
      .where("localId", "in", localIds.slice(i, i + 30))
      .get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }
};

describeCatalogSourceContract("Firestore adapter", async () => {
  const seeded = [];
  return {
    source: firestoreCatalogSource,
    async seed(products) {
      const batch = db.batch();
      for (const { localId, category, available } of products) {
        seeded.push(localId);
        // The Firestore catalog stores the shared category names as they are.
        batch.set(db.collection("products").doc(localId), {
          title: `Contract fixture ${localId}`,
          description: "",
          category,
          image: "",
          currency: "MXN",
          unitPrice: 1500,
          purchaseLimits: { min: 1, max: 10 },
          stock: available,
        });
      }
      await batch.commit();
    },
    async cleanup() {
      await Promise.all(seeded.map((id) => db.collection("products").doc(id).delete()));
      await deleteReservationsOf(seeded);
    },
  };
});

describeCatalogSourceContract("source without reservations (withCoreReservations)", async () => {
  const source = createMemorySource({ key: "mem-core", reservations: false });
  const harness = memoryHarness(source, withCoreReservations(source));
  return {
    ...harness,
    async cleanup() {
      await deleteReservationsOf([...source.products.keys()]);
      await harness.cleanup();
    },
  };
});
