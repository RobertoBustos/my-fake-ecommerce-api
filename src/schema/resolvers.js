import { CartItem, Order, Payment } from "./resolvers/fields.js";
import { Mutation } from "./resolvers/mutations.js";
import { Query } from "./resolvers/queries.js";

const resolvers = { Query, Mutation, CartItem, Order, Payment };

export default resolvers;
