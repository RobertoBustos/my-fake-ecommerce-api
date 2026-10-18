// The only place a price changes currency. Amounts are integer cents in both
// currencies, so a currency without cents (JPY) as either side would need
// its own scale here first.

// Rates are kept with at most this many decimals.
export const RATE_DECIMALS = 8;
const SCALE = 10n ** BigInt(RATE_DECIMALS);

const toScaledRate = (rate: number): bigint => {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`Exchange rate must be a positive number (got ${rate})`);
  }
  // toFixed keeps the decimals as written (17.0123 stays 17.01230000);
  // multiplying the float would bring in binary rounding errors.
  return BigInt(rate.toFixed(RATE_DECIMALS).replace(".", ""));
};

// cents × rate, rounded half to even (banker's rounding): a price that lands
// exactly on half a cent goes to the even cent, so rounding doesn't push
// totals up on average.
export const convertPrice = (cents: number, rate: number): number => {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`Price must be a non-negative integer of cents (got ${cents})`);
  }
  const product = BigInt(cents) * toScaledRate(rate);
  const quotient = product / SCALE;
  const remainder = product % SCALE;
  const twice = remainder * 2n;
  const roundUp = twice > SCALE || (twice === SCALE && quotient % 2n === 1n);
  return Number(roundUp ? quotient + 1n : quotient);
};

export const roundRate = (rate: number): number => Number(rate.toFixed(RATE_DECIMALS));
