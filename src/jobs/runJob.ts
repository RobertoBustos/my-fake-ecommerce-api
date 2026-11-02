import { shutdownTracing, withSpan } from "../observability/spans.js";
import { logger, setLogService } from "../utils/logger.js";

// Runs a job and exits with the code it returns. The run is one trace (a root
// span named after the job), and the spans still buffered are sent before the
// process exits: process.exit would drop them.
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
    await shutdownTracing();
  } catch (err) {
    logger.warn("Could not send the last traces", { error: (err as Error).message });
  }
  process.exit(code);
};
