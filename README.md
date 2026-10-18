# my-fake-ecommerce-api

GraphQL API (Apollo Server 5 on Express) for a practice online store: products,
cart, orders and Stripe payments. Data lives in Firestore, users authenticate
with Firebase Auth, and production runs on Cloud Run behind Firebase Hosting.

- **Production:** `https://my-fake-ecommerce-150b2.web.app/graphql`
- **Health check:** `GET /healthcheck` → `{"status":"ok"}`
- **Stripe webhook:** `POST /webhooks/stripe`
- **Changes per release:** [`CHANGELOG.md`](./CHANGELOG.md)

## Documentation

The project's documentation lives in Confluence (space **Arquitectura Backend**,
written in Spanish) and its work is tracked in Jira (project **ECOMAPI**). Start
with the architecture page, then the runbook.

| Page | What it covers |
|---|---|
| [Arquitectura de la API (v1.0)](https://roberto-bustos-hernandez.atlassian.net/wiki/spaces/ARQ/pages/24674314) | System overview, request lifecycle, purchase and payment flow, CI/CD and releases, with diagrams |
| [Runbook: operación en producción](https://roberto-bustos-hernandez.atlassian.net/wiki/spaces/ARQ/pages/24772610) | Releases, rollbacks, logs and request IDs, common incidents |
| [Guía: pruebas end to end de la API](https://roberto-bustos-hernandez.atlassian.net/wiki/spaces/ARQ/pages/25296898) | How to test the deployed API without the app or any frontend |
| [Guía: configuración manual de GCP](https://roberto-bustos-hernandez.atlassian.net/wiki/spaces/ARQ/pages/24576001) | One-time Google Cloud / Firebase setup behind the deploy pipeline |
| [Guía: configuración manual del webhook de Stripe](https://roberto-bustos-hernandez.atlassian.net/wiki/spaces/ARQ/pages/25100294) | One-time Stripe webhook setup and secret rotation |
| [Guía: configuración manual de Jira y GitHub](https://roberto-bustos-hernandez.atlassian.net/wiki/spaces/ARQ/pages/23625729) | Jira ↔ GitHub integration, branch protection, workflow |
| [Hallazgos técnicos](https://roberto-bustos-hernandez.atlassian.net/wiki/spaces/ARQ/pages/23298055) | Technical findings from the initial code review and how each was addressed |
| [Seguimiento en Jira](https://roberto-bustos-hernandez.atlassian.net/wiki/spaces/ARQ/pages/23068673) | Sprint history, epics and the status of every task |
| [Jira project ECOMAPI](https://roberto-bustos-hernandez.atlassian.net/browse/ECOMAPI) | Backlog and board |

Confluence and Jira are private: ask the project owner for access to the
Atlassian site before following these links.

## Requirements

- Node.js 22 or later
- Java 21 (the Firestore emulator needs it)
- A Stripe account in **test mode**, for `STRIPE_SECRET_KEY`

The Firebase CLI is a dev dependency, so `npx firebase` works without a global
install.

## Run locally

```bash
cp .env.example .env        # then set STRIPE_SECRET_KEY
npm ci

# Terminal 1: Firestore (port 8080) and Auth (port 9099) emulators
npx firebase emulators:start --only firestore,auth --project demo-ecommerce-api

# Terminal 2: load the sample catalog, then start the API on port 4000
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run seed
npm run dev
```

`npm run dev` runs the TypeScript sources directly with `tsx`. To run what
production runs, compile first: `npm run build && npm start` (`dist/index.js`).

Use `npm ci` to install exactly what `package-lock.json` pins. Don't pass
`--legacy-peer-deps` when adding or updating a dependency: the lock file has to
keep the peer dependencies, and CI's `npm ci` fails if it doesn't. If npm 11
crashes with `Cannot read properties of null (reading 'edgesOut')` while
resolving a brand-new tree (no lock file), use npm 12 or later.

Open `http://localhost:4000/graphql` in a browser to get Apollo Sandbox.

**Authentication:** every GraphQL operation needs a Firebase ID token in
`Authorization: Bearer <token>`; without one the API answers `401
UNAUTHENTICATED`. Locally, the token comes from the Auth emulator (the
`.env.example` values already point the API at it):

```bash
# Terminal 3: prints an ID token for dev@example.com (created on first run)
TOKEN=$(npm run -s token:local)
curl -s http://localhost:4000/graphql -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"{ products(first: 3) { edges { node { id title } } } }"}'
```

Pass an email to get a second user, e.g. `npm run -s token:local other@example.com`,
which is handy for checking that one user can't touch another user's orders.
In Apollo Sandbox, paste the token as an `Authorization: Bearer <token>`
header. Emulator tokens only work against the emulator; the deployed API needs
a real Firebase token (see the end-to-end testing guide above).

## TypeScript

The code is TypeScript (`strict`), checked with `npm run typecheck` and
compiled to `dist/` with `npm run build`. The types of the GraphQL schema and
of every resolver are generated from `src/schema/typeDefs` into
`src/generated/graphql.ts`: after changing the schema, run `npm run codegen`
and commit the result. `codegen.ts` maps each schema type to what the
resolvers really return (the Firestore documents in `src/types/models.ts`, or
Stripe objects). Tests stay in JavaScript; Vitest resolves their `.js`
imports to the `.ts` sources.

## Tests

```bash
npm run lint
npm run typecheck
npm run test:emulator   # starts the Firestore and Auth emulators and runs Vitest with coverage
```

`npm test` alone expects an emulator that is already running. CI runs the same
`lint`, `typecheck` and `test` jobs on every pull request (`typecheck` also
fails if `src/generated/graphql.ts` is out of date), plus a secret scan (`gitleaks`), a
Docker build that checks `/healthcheck` (`docker-build`) and, on pull requests
into `main`, `branch-guard`, which only accepts `release/*` and `hotfix/*`
branches.

## Catalog source contract

Every catalog source adapter must pass the same contract suite before it is
registered: `tests/contract/catalogSource.contract.ts` checks the product
shape, missing ids, the shared categories (`src/catalog/categories.ts`), paging
and incremental `listChanged`, and that `reserve`, `confirm` and `release` are
idempotent, expire with the source's TTL and throw `OutOfStockError` or
`ReservationExpiredError` where the purchase flow expects them. CI runs it
against the Firestore adapter and against a source without its own
reservations wrapped with `withCoreReservations`;
`tests/contract/contractSuite.test.js` proves that an adapter breaking any one
rule fails its check.

To run it against a new source, add a test file that gives the suite a
harness: the source as the registry serves it, a `seed` that writes products
into the source's own store (with its own category names) and a `cleanup`.

```js
// tests/contract/mysqlOutletSource.contract.test.js
import { describeCatalogSourceContract } from "./catalogSource.contract.js";

describeCatalogSourceContract("MySQL outlet adapter", async () => {
  const db = await startTestDatabase(); // Testcontainers or the source's emulator
  const source = createMysqlOutletSource(db);
  return {
    source, // or withCoreReservations(source) if it can't reserve
    seed: (products) => insertProducts(db, products),
    cleanup: () => db.stop(),
  };
});
```

For a database with a Docker image (MySQL, Postgres/Supabase, MongoDB), start
it in the factory with [Testcontainers](https://node.testcontainers.org/) and
stop it in `cleanup`; GitHub's Ubuntu runners have Docker. For a service with
an emulator, start the emulator around the test run the way
`npm run test:emulator` does for Firestore. Run one suite with
`npx vitest run tests/contract/<file>` (under the emulator if the source needs
Firestore, as sources without reservations do).

## Purchase flow

1. `products`: browse the catalog. `Product.id` is an opaque global id that
   names the product's catalog source; `Product.source` is that source's
   display name
2. `addToCart`: add products to a cart (`cartId` is generated by the client).
   The item keeps a copy of the product (price, title, image, currency) and a
   reservation of its units in the product's source, which expires after
   `RESERVATION_TTL_MINUTES_<SOURCE>` minutes (60 by default)
3. `createOrder`: create the order from the cart (`INCOMPLETE`)
4. `updateOrder`: add customer and shipping details (`PAYMENT_PENDING`)
5. `createOrderPayment`: create the Stripe PaymentIntent; the client confirms it.
   If a price changed since the items were added, nothing is charged: the
   items move to the new price and the call answers `BAD_USER_INPUT` with
   `priceChanges`, so the client can show the new total and call it again.
   An item whose reservation expired answers `BAD_USER_INPUT` with
   `expiredItemIds`: remove it and add it again to reserve its units anew
6. Stripe sends `payment_intent.succeeded` to the webhook, which marks the
   order `COMPLETE` and confirms its reservations in their sources

## Inventory queue

Confirming and releasing reservations is a saga across the catalog sources:
the webhook, `removeFromCart` and `cancelOrder` write each confirm or release
to `inventoryTasks` in the same transaction that changes the order or the
item, then run it right away. What a source refuses stays queued and is
retried with backoff (1, 2, 4… minutes, at most an hour) by the inventory job,
up to `INVENTORY_TASK_MAX_ATTEMPTS` attempts (8 by default). A task out of
attempts is `FAILED` and logged as an error; a paid order stays `COMPLETE`.

The same job sweeps reservations that expired in abandoned carts and releases
their units, except for orders that are `PAYMENT_PENDING` or `COMPLETE`.

```bash
npm run inventory:process              # one pass of the job: sweep, then run due tasks
npm run inventory:retry -- <taskId>    # put a FAILED task back and run it
```

The queries of the job need the composite indexes in `firestore.indexes.json`
(`npx firebase deploy --only firestore:indexes`).

## Catalog index

The `catalog` collection holds a copy of every product of every switched-on
source (global id, `sourceKey`, title, description, image, category, price and
currency in the source, approximate `available` and `syncedAt`), so the
catalog can be listed and filtered with one Firestore query. The catalog sync
job keeps it up to date:

- **Pull:** `listChanged(since)` from the mark saved in `catalogSync/{source}`.
  Each page is written and its cursor saved, so a run that stops halfway
  resumes there. `deletedIds` are removed from the index.
- **Reconciliation:** a full pass that also deletes what the source no longer
  has. It runs on the first sync of a source and then every
  `CATALOG_RECONCILE_HOURS` (24 by default).
- Only the sources in `CATALOG_SOURCES` are synced. Firestore products carry an
  `updatedAt` (set by the seed and by every stock change), so its pulls are
  incremental; products without it are picked up by the reconciliation.

```bash
npm run catalog:sync                          # one run: pull, or reconcile when due
npm run catalog:sync -- --reconcile           # reconcile every source now
npm run catalog:sync -- --source fs           # only one source
```

The `products` query and `CartItem.product` read the index, so listing the
catalog is one Firestore query and a source that is down doesn't hide its
products. Their price and stock are as of the last sync; `addToCart` and
`createOrderPayment` still ask the product's source, and answer `CONFLICT` with
`retryable` while it can't be reached. Products of sources outside
`CATALOG_SOURCES` aren't listed. `npm run seed` indexes what it writes.

## Prices and currency

Everything is shown and charged in one settlement currency, MXN today. It lives
in the Firestore document `settings/pricing`, not in the code:

```json
{ "settlementCurrency": "MXN", "rateProvider": "banxico", "maxRateAgeHours": 24 }
```

Each instance re-reads it every 30 seconds (`PRICING_SETTINGS_TTL_MS`); without
the document, those defaults apply. A product whose source quotes another
currency is converted with `exchangeRates/{FROM}_{TO}`, which the daily rates job
(`npm run rates:refresh`, needs `BANXICO_TOKEN`) keeps up to date. A rate the job
hasn't confirmed within `maxRateAgeHours` can't be used: the product is shown in
its own currency and `addToCart` answers `CONFLICT` with `retryable`. Conversion
happens only in `convertPrice` (`src/pricing/convert.ts`). Clients should show
the symbol from each price's `currency` field instead of assuming MXN.

## Deployment

Pushing a `v*` tag from `main` runs `.github/workflows/deploy.yml`: it builds the
image, deploys it to Cloud Run, updates Firebase Hosting and smoke-tests
`/healthcheck`. `.github/workflows/rollback.yml` moves traffic back to an earlier
release. Details are in the runbook.

## Branches and commits

- All development goes into `dev` through pull requests; `main` only receives
  releases (`release/sprint-<n>`) and hotfixes (`hotfix/ECOMAPI-<n>-<slug>`).
- `dev` and `main` are protected: a pull request and green `lint`, `test`,
  `gitleaks`, `docker-build` and `typecheck` checks are required to merge (`main` also
  requires `branch-guard`).
- Layering: GraphQL mutations go through `src/services/`; only the read-only
  resolvers (`src/schema/resolvers/queries.ts` and `fields.ts`) may import
  `src/db/` directly. Products and stock are reached through the
  `CatalogSource` contract in `src/catalog/`; only an adapter under
  `src/catalog/sources/` may use a database client. ESLint enforces both.
- Branches are named `ECOMAPI-<n>-<short-slug>`, and commits and pull request
  titles start with the Jira key (`ECOMAPI-<n>: ...`).
- Everything that reaches GitHub is written in English: commits, pull requests,
  code comments and test names.

More detail on these conventions in [`CLAUDE.md`](./CLAUDE.md).
