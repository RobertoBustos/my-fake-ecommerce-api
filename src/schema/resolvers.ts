import { CartItem, Order, Payment, Product } from "./resolvers/fields.ts";
import { Mutation } from "./resolvers/mutations.ts";
import { Query } from "./resolvers/queries.ts";
import type { Resolvers } from "#src/generated/graphql";

const resolvers: Resolvers = { Query, Mutation, CartItem, Order, Payment, Product };

export default resolvers;
