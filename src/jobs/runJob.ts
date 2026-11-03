import { shutdownTelemetry } from "#src/observability/lifecycle";
import { withSpan } from "#src/observability/spans";
import { logger, setLogService } from "#src/utils/logger";

// Runs a job and exits with the code it returns. The run is one trace (a root
// span named after the job), and the spans and metric points still buffered
// are sent before the process exits: process.exit would drop them.
export const runJob = async (name: string, work: () => Promise<number>) => {
  // Named like its Cloud Run job, so Error Reporting groups its errors apart.
  setLogService(name);
  let code: number;
  try {
    code = await withSpan(`job ${name}`, work);
  } catch (err) {
    logger.error("Job failed", { error: (err as Error).message, stack: (err as Error).stack });
    code = 1;
  }
  try {
    await shutdownTelemetry();
  } catch (err) {
    logger.warn("Could not send the last traces and metrics", { error: (err as Error).message });
  }
  process.exit(code);
};

// Takes a measurement for the job's metrics. A measurement that fails is a
// WARNING and never fails the run: the job did its work.
export const measure = async (what: string, work: () => Promise<void>) => {
  try {
    await work();
  } catch (err) {
    logger.warn(`Could not measure ${what}`, { error: (err as Error).message });
  }
};
