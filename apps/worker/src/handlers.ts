/** Реєстрація обробників черги (спільна для процесу worker і для in-process e2e-тестів). */
import type { Job } from "pg-boss";
import { Q, QUEUE_SPECS, type JobData, type QueueName } from "@sitelens/pipeline";
import { accessibilityJob } from "./jobs/accessibility.js";
import { aggregateJob } from "./jobs/aggregate.js";
import { captureJob } from "./jobs/capture.js";
import { crawlJob } from "./jobs/crawl.js";
import { LLM_JOBS, llmStageJob } from "./jobs/llm.js";
import { reportJob } from "./jobs/report.js";
import { browserJob, snapshotJob } from "./jobs/scenarios.js";
import { lighthouseJob } from "./jobs/lighthouse.js";
import type { Runtime } from "./runtime.js";

export async function registerHandlers(rt: Runtime): Promise<void> {
  const { boss } = rt;
  const handler = (name: QueueName, fn: (rt: Runtime, job: Job<JobData>) => Promise<void>) => async (jobs: Job<JobData>[]) => {
    for (const job of jobs) {
      const t0 = Date.now();
      try {
        await fn(rt, job);
        rt.log("info", "job done", { queue: name, job: job.id, audit: job.data.auditRunId, retry: job.retryCount, ms: Date.now() - t0 });
      } catch (e) {
        rt.log("error", "job failed (буде повтор, якщо лишились спроби)", { queue: name, job: job.id, audit: job.data.auditRunId, retry: job.retryCount, err: String((e as Error).message).slice(0, 300) });
        throw e;
      }
    }
  };
  const reg = async (name: QueueName, fn: (rt: Runtime, job: Job<JobData>) => Promise<void>) =>
    boss.work<JobData>(name, { localConcurrency: QUEUE_SPECS[name].concurrency, batchSize: 1, pollingIntervalSeconds: 1 }, handler(name, fn));
  await reg(Q.crawl, crawlJob);
  await reg(Q.capture, captureJob);
  await reg(Q.lighthouse, lighthouseJob);
  await reg(Q.accessibility, accessibilityJob);
  for (const name of Object.keys(LLM_JOBS)) await reg(name as QueueName, (r, j) => llmStageJob(r, name, j));
  await reg(Q.snapshot, snapshotJob);
  await reg(Q.browser, browserJob);
  await reg(Q.aggregate, aggregateJob);
  await reg(Q.report, reportJob);
}
