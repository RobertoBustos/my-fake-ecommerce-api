# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/).

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

[1.0.1]: https://github.com/RobertoBustos/my-fake-ecommerce-api/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/RobertoBustos/my-fake-ecommerce-api/compare/v0.1.1...v1.0.0
[0.1.1]: https://github.com/RobertoBustos/my-fake-ecommerce-api/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/RobertoBustos/my-fake-ecommerce-api/releases/tag/v0.1.0
