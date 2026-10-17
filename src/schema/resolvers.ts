import { CartItem, Order, Payment } from "./resolvers/fields.js";
import { Mutation } from "./resolvers/mutations.js";
import { Query } from "./resolvers/queries.js";
import type { Resolvers } from "../generated/graphql.js";

const resolvers: Resolvers = { Query, Mutation, CartItem, Order, Payment };

export default resolvers;
