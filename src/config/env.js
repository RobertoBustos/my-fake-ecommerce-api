// npm start already loads .env via --env-file (H12: there used to be two mechanisms for this).
// A Proxy (not a spread snapshot) so every read stays live against
// process.env — tests set vars like STRIPE_WEBHOOK_SECRET after this module
// has already been imported once, and a snapshot would miss that.
// HOST/PORT get a fallback only when unset (e.g. Docker/Cloud Run, which has
// no .env file): HOST must be 0.0.0.0 to accept connections from outside the
// container, and PORT must have a usable value even if the platform doesn't
// inject one.
const defaults = { HOST: "0.0.0.0", PORT: 8080 };

export default new Proxy(process.env, {
  get: (target, prop) => target[prop] || defaults[prop],
});
