import env from "../config/env.js";

const DEFAULT_TTL_MINUTES = 60;

// How long a reservation of each source holds its units before it counts as
// expired: RESERVATION_TTL_MINUTES_<KEY> ("fs" → RESERVATION_TTL_MINUTES_FS,
// "mysql-outlet" → RESERVATION_TTL_MINUTES_MYSQL_OUTLET), 60 by default. Read
// on every call, so a change applies to the next reservation.
export const reservationTtlMs = (sourceKey: string): number => {
  const name = `RESERVATION_TTL_MINUTES_${sourceKey.toUpperCase().replace(/-/g, "_")}`;
  const minutes = Number(env[name]);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TTL_MINUTES) * 60_000;
};
