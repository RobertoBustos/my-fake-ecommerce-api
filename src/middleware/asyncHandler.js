// Express 4 doesn't catch rejected promises from async handlers: the request
// hangs and, on Node 20, the unhandled rejection kills the process. This
// forwards the error to the Express error handler instead.
export const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
