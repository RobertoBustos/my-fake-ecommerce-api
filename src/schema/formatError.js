// Apollo ya clasifica cualquier excepción que no sea un GraphQLError propio
// (con su propio extensions.code) como INTERNAL_SERVER_ERROR, pero sin
// ocultar el mensaje original fuera de NODE_ENV=production. Lo forzamos
// aquí para que el comportamiento sea el mismo en dev, test y prod.
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
