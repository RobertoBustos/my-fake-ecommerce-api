# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A configurable settlement currency (MXN), read from the Firestore document
  `settings/pricing` and applied without a deploy. Products priced in another
  currency are shown, added to the cart and charged converted with a daily
  exchange rate (`exchangeRates`); the cart item keeps the original price and
  currency, the rate and its date.
- `CartItem.currency`.
- Stock reservations: each `addToCart` reserves its units in the product's
  source (`reservations` collection for Firestore) with an idempotency key and an
  expiry (`RESERVATION_TTL_MINUTES_<SOURCE>`, 60 minutes by default);
  `removeFromCart` and `cancelOrder` release them, once however often they are
  retried. Sources that can't reserve get their reservations kept in Firestore
  and checked against the source when confirmed.
- A daily exchange rates job (`src/jobs/refreshExchangeRates.ts`, `npm run
  rates:refresh`) with Banxico's FIX rate as its first provider.
- An inventory queue (`inventoryTasks`): the webhook, `removeFromCart` and
  `cancelOrder` record the confirm or release of each reservation in the same
  write that changes the order or the item, so a source that is down doesn't
  lose the sale or the stock. The inventory job (`src/jobs/processInventory.ts`,
  `npm run inventory:process`) retries them with backoff up to
  `INVENTORY_TASK_MAX_ATTEMPTS` times and logs the ones that still fail
  (`Sold units not confirmed in their source`, `Reserved stock not released`);
  `npm run inventory:retry -- <taskId>` retries one by hand.
- The inventory job also releases reservations that expired in abandoned carts,
  except for orders being paid (`PAYMENT_PENDING`) or paid.
- Composite indexes for the job's queries in `firestore.indexes.json`.
- A catalog index (`catalog` collection) and its sync job
  (`src/jobs/syncCatalog.ts`, `npm run catalog:sync`): an incremental pull of
  each switched-on source from its last mark, resumable halfway, and a full
  reconciliation every `CATALOG_RECONCILE_HOURS` that removes what a source no
  longer has. Sources can push their changes through the optional
  `subscribeChanges` hook (not used by any source yet).
- `updatedAt` on Firestore products, set by the seed and by every stock change,
  so the Firestore source lists only what changed since a date.
- A contract test suite every catalog source adapter must pass
  (`tests/contract/catalogSource.contract.ts`), run in CI against the Firestore
  adapter and a source whose reservations the core keeps, and the shared
  category list sources map their categories to (`src/catalog/categories.ts`).

- `Product.source`: display name of the catalog source the product comes from.
- `scripts/migrateCartItemProductIds.ts` (`npm run migrate:product-ids`, dry run
  unless `--apply`) rewrites the product id of existing cart items to the global
  id and fills in their copy of the product.

### Changed

- `products` and `CartItem.product` are served from the catalog index instead of
  each source: price and stock shown there are as of the last catalog sync (the
  cart and the payment still use the source's current ones). Products cursors
  are now based on the global product id, so a cursor from an earlier version
  is rejected with `BAD_USER_INPUT`; start again from the first page.
- `addToCart` and `createOrderPayment` answer `CONFLICT` with `retryable: true`
  when a product's source can't be reached, instead of `INTERNAL_SERVER_ERROR`.
- `npm run seed` also indexes the seeded products.
- `Product.id` (and `CartItem.productId`) is now an opaque global id that names
  the product's catalog source. The bare ids from before are still accepted as
  input (`products(id:)`, `addToCart`, `carts(productId:)`) for one release.
- Cart items keep a copy of the product (title, image, currency and source)
  next to the price, so an order no longer depends on the source after the
  product is added.
- `createOrderPayment` checks every item against the price its source quotes
  now. If a price changed, nothing is charged: the items move to the new price
  and the call answers `BAD_USER_INPUT` with `priceChanges` (`productId`,
  `previousUnitPrice`, `unitPrice`); calling it again charges the new total. A
  product the source no longer has answers `BAD_USER_INPUT` with
  `unavailableProductIds`.
- `createOrderPayment` refuses an order with an expired stock reservation
  (`BAD_USER_INPUT` with `expiredItemIds`); removing those items and adding them
  again reserves their units anew.
- A paid order's reservations are confirmed in their sources, so they can no
  longer be released.
- `createOrderPayment` also converts again with today's rate and settlement
  currency; `priceChanges` now carries `previousCurrency` and `currency`. The
  PaymentIntent is created in the settlement currency. A product without a usable
  exchange rate can't be added to a cart or paid for (`CONFLICT`, `retryable`).

### Removed

- `npm run cleanup:cart-items` (`scripts/cleanupOrphanCartItems.ts`): the
  inventory job's sweep releases abandoned reservations instead. Its last
  production run, after v1.3.0, found nothing to release.

## [1.3.0] - 2026-10-17

The technical debt that was accepted for v1.2.0: lists are paginated inside
Firestore, the API runs on Express 5 and is written in TypeScript, dependency
updates are tracked automatically, and cart items left without an owner can be
released. No change is visible to clients.

### Changed

- `products`, `carts`, `orders` and `incompleteOrders` are paginated inside the
  Firestore query instead of reading the whole collection and cutting it in
  memory: a page reads at most `first + 1` documents. Lists are still ordered by
  document id, cursors keep the same format, and an unknown `after` still
  answers `BAD_USER_INPUT`. `incompleteOrders` filters by status in the query.
- Express 5 with `@as-integrations/express5`. Express 5 forwards rejected
  promises from async handlers to the error handler, so the `asyncHandler`
  wrapper is gone.
- The code is TypeScript in strict mode. The types of the GraphQL schema and of
  every resolver are generated from `src/schema/typeDefs` with graphql-codegen
  (`npm run codegen`), and the Zod validators export their input types.
- The Docker image is built in two stages: the first compiles TypeScript, the
  final one ships only `dist/` and the production dependencies and starts with
  `node dist/index.js`.
- Dependencies are installed with `npm ci`, without `--legacy-peer-deps`.

### Added

- `npm run cleanup:cart-items`: finds cart items created before v1.2.0, which
  have no owner and hold stock nobody can release, and with `--apply` deletes
  them and returns their units, one transaction per item. Items of cancelled,
  paid or open orders are only reported. A dry run against production found
  none to release.
- Dependabot opens weekly pull requests into `dev` for npm and GitHub Actions
  updates (minor and patch versions grouped, each major on its own).
- npm scripts: `build`, `typecheck`, `codegen` and `dev` (runs the sources with
  `tsx`). `npm start` now runs the compiled `dist/index.js`.

### CI

- New `typecheck` job (types, build, and a check that
  `src/generated/graphql.ts` matches the schema), required on `dev` and `main`.
- New `audit` job: fails on high vulnerabilities in production dependencies. It
  is not a required check.

### Removed

- `src/middleware/asyncHandler` (no longer needed with Express 5).
- The `--legacy-peer-deps` flag from the README, CI, the deploy workflow and the
  Dockerfile.

## [1.2.0] - 2026-10-17

The technical debt left before the end-to-end suite: every write checks who
owns the data, orders follow strict status rules, payments are checked against
what Stripe charged, every input is validated, and the platform moves to
Node 22 and Apollo Server 5.

### Security

- Every mutation now checks that the order or cart belongs to the
  authenticated user. Before, any signed-in user who knew another user's order
  id could update it, cancel it or start its payment, and the `carts` query
  showed other users' carts. A foreign id now answers `NOT_FOUND`, exactly
  like a missing one, so it doesn't reveal that the id exists.
- Cart items store the `userId` of whoever created them, and a `cartId`
  belongs to the first user who adds to it. Items created before this release
  have no `userId`, so nobody can modify them any more.
- The Stripe customer is tied to the Firebase user (`users/{uid}`) instead of
  being looked up by the email typed in `updateOrder`. Before, a user who
  typed someone else's email got that person's Stripe customer, and the
  ephemeral key exposed their saved cards in the Payment Sheet. Customers that
  were created by email are not migrated: each user gets a new one.
- `firestore.rules` denies every direct read and write. The API uses the Admin
  SDK, which bypasses the rules, so nothing changes for it; the old rules in
  the repo (`allow read, write: if true`) would have opened the database if
  they had ever been deployed.
- In production, GraphQL validation errors no longer suggest field names
  ("did you mean ...").

### Fixed

- Stock is returned to the product when a cart item is removed or an order is
  cancelled. Before, `addToCart` took units out of stock and nothing put them
  back. Cancelling happens in one transaction, so a second cancel doesn't
  return the stock again.
- Order status follows fixed transitions: `INCOMPLETE` -> `PAYMENT_PENDING`
  (`updateOrder`), `INCOMPLETE`/`PAYMENT_PENDING` -> `CANCELLED`
  (`cancelOrder`) and `PAYMENT_PENDING` -> `COMPLETE` (Stripe webhook only).
  Before, `updateOrder` moved a paid order back to `PAYMENT_PENDING` and
  revived cancelled orders, and a cancelled order could still be paid.
- The Stripe webhook completes an order only when the event's PaymentIntent is
  the order's and `amount_received` equals the current order total.
  Otherwise it answers 200 (so Stripe stops retrying) and logs an error with
  the reason.
- `createOrder` on a cart that was already turned into an order answers
  `BAD_USER_INPUT` instead of creating an empty second order.
- `addToCart` with an `orderId` now puts the item in that order's total, and
  `removeFromCart` can't return stock from a paid order.
- Concurrent purchases of the same product retry the stock transaction up to
  10 times and, if they still lose, answer `CONFLICT` with
  `retryable: true` instead of an internal error.
- The server shuts down gracefully on `SIGTERM`: Cloud Run sends it on every
  deploy, and the process used to stop immediately, cutting requests in
  flight. It now waits up to 8 seconds for them to finish.

### Changed

These change what clients see; review them before updating the app.

- Invalid input answers `BAD_USER_INPUT` everywhere, with the failing field in
  `extensions.invalidArgument` (for example `customer.email`). The order
  mutations and `removeFromCart` used to answer `BAD_REQUEST`.
- Every mutation validates its input: valid email, name of 1 to 100
  characters, phone of 10 to 15 digits with an optional `+`, non-blank
  address, zip code of 3 to 10 characters, latitude within +/-90 and longitude
  within +/-180. `updateOrder` needs `customer` or `address`.
- Lists are paginated with `first` between 1 and 100. Without `first` a list
  returns at most 20 items (it used to return everything), and an unknown
  `after` cursor answers `BAD_USER_INPUT` instead of an empty page.
- `COMPLETE` and `CANCELLED` orders are final: `updateOrder`, `addToCart`
  and `removeFromCart` on them answer `BAD_USER_INPUT`. `cancelOrder` answers
  `BAD_USER_INPUT` for a paid order and does nothing for an order that is
  already cancelled. `createOrderPayment` needs a `PAYMENT_PENDING` order with
  a total above 0.
- `removeFromCart` answers `NOT_FOUND` for a missing item instead of
  `success: false`.
- Node 22 is required (`engines`), in the container image and in CI; Node 20
  is out of support. Apollo Server moves from 4 to 5 through
  `@as-integrations/express4`. `npm audit --omit=dev` reports no
  vulnerabilities.

### Added

- Local development with the Firebase Auth emulator: `npm run token:local`
  prints an ID token the local API accepts (pass an email for a second user),
  and `npm run test:emulator` now starts both the Firestore and Auth
  emulators.

## [1.1.0] - 2026-10-16

Technical debt cleanup after Sprint 2: stricter quality gates, documentation
in English and production hardening.

### Changed

- GraphQL introspection is turned off in production. The container now runs
  with `NODE_ENV=production`, so `__schema` and `__type` queries are rejected
  with HTTP 400 (`GRAPHQL_VALIDATION_FAILED`) and `/graphql` no longer serves
  Apollo Sandbox there. Regular queries and mutations are unaffected; local
  runs and tests keep introspection on. Before this, introspection queries
  also bypassed the query depth limit.
- The resolvers are split into read-only queries and field resolvers, which
  may read the database directly, and mutations, which must go through the
  services layer. ESLint now enforces this.
- The README is rewritten in English, with local setup, tests, deployment and
  links to the project documentation in Confluence and Jira.
- `CLAUDE.md` (the repository conventions) documents the release and hotfix
  branches allowed into `main`, the required checks and the layering rule.
- `.env.example` now uses port 4000 for the API, since the Firestore emulator
  already listens on 8080.

### Removed

- Unused file helpers left over from the JSON-file storage
  (`src/utils/fileUtils.js`, `src/utils/fakePromise.js`).

### CI

- New `branch-guard` job: pull requests into `main` must come from a
  `release/*` or `hotfix/*` branch.
- `gitleaks` and `docker-build` are now required checks on `dev` and `main`,
  together with `lint` and `test` (and `branch-guard` on `main`).
- Lint runs with ESLint's recommended defaults as errors; the last warnings
  were fixed.

## [1.0.1] - 2026-10-16

### Fixed

- The health check moved from `/healthz` to `/healthcheck`. Cloud Run reserves
  some paths ending in `z` and answered `/healthz` with its own 404, so the
  check was unreachable in production and the deploy smoke test failed.

## [1.0.0] - 2026-10-16

Sprint 2 (days 6-10): authentication, Stripe payments confirmed by webhook,
quality gates, and the first production deploy to Cloud Run behind Firebase
Hosting.

### Breaking changes

- The GraphQL endpoint moved from the server root to `POST /graphql`, served
  by Express.
- Every GraphQL request needs a Firebase ID token in
  `Authorization: Bearer <token>`. A missing or invalid token is rejected with
  HTTP 401 and `extensions.code = "UNAUTHENTICATED"`.
- Clients can no longer set an order's `status`: the field was removed from
  the order update input. An order becomes `COMPLETE` only when Stripe
  confirms the payment through the webhook.
- Order queries and order creation are scoped to the authenticated user;
  another user's order is not visible.

### Added

- Stripe webhook at `POST /webhooks/stripe` with signature verification.
  Each event is applied once, even when Stripe delivers it again, and a
  failed event is answered with a 500 so Stripe retries it.
- Idempotency key on PaymentIntent creation, so a retried request doesn't
  create a second charge.
- `GET /healthz` health check.
- JSON logs (one line per entry, readable by Cloud Logging). Every request
  gets an ID, returned in the `X-Request-Id` header and attached to its logs;
  unexpected errors are logged with their real message and stack.
- Query depth limit for GraphQL operations.
- Dockerfile; the server listens on `0.0.0.0:8080` when no `.env` is present.
- Deploy workflow: release tags build the image and deploy it to Cloud Run
  through Workload Identity Federation, then publish Firebase Hosting, which
  forwards every path to the service. A smoke test checks `/healthz` on both.
- Manual rollback workflow that moves traffic back to the previous revision
  or to a given release.
- CI: secret scanning with gitleaks, a Docker build check, an end-to-end
  purchase flow test against the Firestore emulator, and a 70% coverage
  threshold on `src/services`.

### Fixed

- Single quotes in a customer email no longer break the Stripe customer
  search.
- An error while handling a Stripe webhook no longer crashes the process.

### Changed

- Code comments and test names translated to English.

## [0.1.1] - 2026-10-15

### Fixed

- Stale fakestoreapi.com image URLs in the seeded product catalog.

## [0.1.0] - 2026-10-15

Sprint 1 (days 1-5): CI, layered architecture (`services/` with thin
resolvers), Zod validation, Firestore storage with transactions, DataLoader
against N+1 queries, and edge-level error handling.

### Breaking changes

- `products`, `carts`, `orders` and `incompleteOrders` return Relay-style
  connections (`edges`/`node`/`pageInfo`) instead of flat lists; the generic
  `filter` argument was replaced with explicit typed arguments.
- The API requires Firestore (emulator or a real project) instead of local
  JSON files.

[1.3.0]: https://github.com/RobertoBustos/my-fake-ecommerce-api/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/RobertoBustos/my-fake-ecommerce-api/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/RobertoBustos/my-fake-ecommerce-api/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/RobertoBustos/my-fake-ecommerce-api/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/RobertoBustos/my-fake-ecommerce-api/compare/v0.1.1...v1.0.0
[0.1.1]: https://github.com/RobertoBustos/my-fake-ecommerce-api/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/RobertoBustos/my-fake-ecommerce-api/releases/tag/v0.1.0
