// Apollo already classifies any exception that isn't our own GraphQLError
// (with its own extensions.code) as INTERNAL_SERVER_ERROR, but it doesn't
// hide the original message unless NODE_ENV=production. We force it here
// so the behavior is the same in dev, test and prod.
export const formatError = (formattedError) => {
  if (formattedError.extensions?.code !== "INTERNAL_SERVER_ERROR") {
    return formattedError;
  }
  return {
    ...formattedError,
    message: "Unexpected error, please try again later",
    extensions: { code: "INTERNAL_SERVER_ERROR" },
  };
};
