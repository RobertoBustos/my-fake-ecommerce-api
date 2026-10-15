# my-fake-ecommerce-api

API GraphQL (Apollo Server) para una tienda en línea de práctica: productos, carrito, órdenes y pagos con Stripe.

## Requisitos

- Node.js 20 o superior
- Una cuenta de Stripe en **modo de prueba** (test mode), para `STRIPE_SECRET_KEY`

## Ejecutar

```bash
cp .env.example .env
# edita .env: STRIPE_SECRET_KEY, HOST, PORT
npm install --legacy-peer-deps
npm start
```

`npm install --legacy-peer-deps` es necesario: con npm 11, un `npm install` normal
falla por un bug al resolver los peer dependencies de eslint/vitest.

Con el servidor corriendo, abre Apollo Sandbox en `http://localhost:8080` (o el
`PORT` que hayas puesto en `.env`).

## Flujo de compra

1. `products` — ver el catálogo
2. `addToCart` — agregar productos a un carrito
3. `createOrder` — crear la orden a partir del carrito
4. `updateOrder` — agregar datos del cliente y de envío
5. `createOrderPayment` — generar el PaymentIntent de Stripe para cobrar

## Flujo de ramas

- Todo el desarrollo entra a `dev` por pull request; `main` solo recibe
  releases (`release/sprint-<n>`) y hotfixes.
- `dev` y `main` están protegidas: PR obligatorio y los checks `lint` y
  `test` en verde antes de fusionar.
- Commits y PRs: clave de Jira al inicio (`ECOMAPI-<n>: ...`).

Más detalle de convenciones en [`CLAUDE.md`](./CLAUDE.md).
