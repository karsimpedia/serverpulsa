// queues.js
import "dotenv/config";
import { Queue, QueueEvents } from "bullmq";

export const QUEUE_NAME = process.env.QUEUE_NAME || "trxQueue";

/**
 * Build connection options untuk BullMQ v5.
 * - Jika REDIS_URL ada (mis. redis://user:pass@redis:6379/0), kita parse manual.
 * - Jika tidak, fallback ke host/port env atau default 'redis:6379'.
 */
function buildConnection() {
  const url = process.env.REDIS_URL;
  if (url) {
    const u = new URL(url);
    const dbStr = u.pathname?.replace("/", "") || "0";
    return {
      host: u.hostname || "redis",
      port: Number(u.port || 6379),
      password: u.password || undefined,
      db: Number.isFinite(Number(dbStr)) ? Number(dbStr) : 0,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }
  return {
    host: process.env.REDIS_HOST || "redis",
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB || 0),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

export const connection = buildConnection();

// Inisialisasi Queue & Event stream (BullMQ v5)
export const trxQueue = new Queue(QUEUE_NAME, { connection });
export const trxEvents = new QueueEvents(QUEUE_NAME, { connection });

// Event logs
trxEvents.on("completed", ({ jobId }) => {
  console.log(`✅ Job done: ${jobId}`);
});
trxEvents.on("failed", ({ jobId, failedReason }) => {
  console.error(`💥 Job failed: ${jobId} — ${failedReason}`);
});
trxEvents.on("error", (err) => {
  console.error("QueueEvents error:", err?.message || err);
});

// Graceful shutdown (tanpa QueueScheduler)
export async function closeQueues() {
  await Promise.allSettled([trxEvents.close(), trxQueue.close()]);
  console.log("👋 Queues closed.");
}
process.on("SIGINT", closeQueues);
process.on("SIGTERM", closeQueues);
