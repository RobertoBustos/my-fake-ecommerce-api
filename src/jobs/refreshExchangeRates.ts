import { refreshExchangeRates } from "#src/pricing/refreshRates";
import { logger } from "#src/utils/logger";
import { runJob } from "./runJob.ts";

// The daily exchange rates job. It ships in the same image as the API, so a
// Cloud Run job can run it with `node dist/jobs/refreshExchangeRates.js`
// (Cloud Scheduler starts that job once a day); locally,
// `npm run rates:refresh`. A failure exits with 1 so the job run shows as failed.

await runJob("refresh-exchange-rates", async () => {
  try {
    const written = await refreshExchangeRates();
    logger.info("Exchange rates refreshed", {
      rates: written.map(({ from, to, rate, asOf }) => ({ pair: `${from}_${to}`, rate, asOf })),
    });
    return 0;
  } catch (err) {
    logger.error("Exchange rates refresh failed", { error: (err as Error).message });
    return 1;
  }
});
