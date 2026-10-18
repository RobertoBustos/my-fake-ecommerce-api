import type Stripe from "stripe";

// Shapes of the Firestore documents. Every repository in src/db/ returns
// these (with the document id merged in), and the GraphQL resolvers map them
// to the schema types through the codegen mappers (codegen.ts).

export type OrderStatus = "INCOMPLETE" | "PAYMENT_PENDING" | "COMPLETE" | "CANCELLED";

export interface Product {
  // Global id (catalog/productId.ts) when it comes from the catalog; the
  // Firestore document id inside db/products.ts.
  id: string;
  title: string;
  description: string;
  category: string;
  image: string;
  stock: number;
  currency: string;
  // Centavos (10995 = 109.95 MXN).
  unitPrice: number;
  purchaseLimits: { min: number; max: number };
  // Display name of the product's source; set by the catalog.
  source?: string | null;
}

export interface CartItem {
  id: string;
  cartId: string;
  // null while the item is still free in its cart.
  orderId: string | null;
  // null for items created before v1.2.0 (ownership checks).
  userId: string | null;
  // Global product id; items written before global ids keep the bare
  // Firestore id until the migration script rewrites them.
  productId: string;
  quantity: number;
  // Copy of the product taken when it was added: the order, its totals, the
  // PaymentIntent and the webhook read only this copy, never the source.
  // unitPrice and currency are in the settlement currency; the price and
  // currency the source quoted will sit next to them once prices are
  // converted. sourceKey, title, image and currency are missing on items
  // written before the copy existed.
  unitPrice: number;
  subtotal: number;
  sourceKey?: string;
  title?: string | null;
  image?: string | null;
  currency?: string | null;
}

// updateOrder stores the whole Stripe customer returned by Stripe.
export type StripeCustomer = Stripe.Customer;
export type StripePaymentIntent = Stripe.PaymentIntent;
export type StripePaymentMethod = Stripe.PaymentMethod;

export interface Coords {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

export interface Address {
  address: string;
  zipCode: string;
  coords: Coords;
}

export interface Order {
  id: string;
  cart: string;
  status: OrderStatus;
  userId: string | null;
  customer: StripeCustomer | null;
  address: Address | null;
  paymentId: string | null;
}

// users/{uid}
export interface User {
  stripeCustomerId?: string;
}

export interface OrderTotals {
  currency: string;
  items: number;
  units: number;
  subTotal: number;
  taxes: number;
  discount: number;
  total: number;
}

export interface Page {
  first?: number | null;
  after?: string | null;
}

export interface Connection<T> {
  edges: { node: T; cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

// What every mutation answers (the MutationResponse interface in the schema).
export interface MutationAck {
  code: string;
  success: boolean;
  message: string;
}

// A response with data; T includes null when the schema allows it.
export interface MutationResult<T> extends MutationAck {
  data: T;
}
