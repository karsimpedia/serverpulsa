// queues.js
import 'dotenv/config';
import IORedis from 'ioredis';
import { Queue, QueueScheduler, QueueEvents } from 'bullmq';

/**
 * Prefer REDIS_URL (e.g. redis://redis:6379). fallback ke HOST/PORT/PASSWORD.
 */
const redisUrl = process.env.REDIS_URL;
let connection;

if (redisUrl) {
  connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
} else {
  connection = new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

/**
 * Single queue for all trx jobs.
 * Names must match between API (producer) & worker (consumer).
 */
export const QUEUE_NAME = 'trxQueue';

export const trxQueue = new Queue(QUEUE_NAME, { connection });
export const trxScheduler = new QueueScheduler(QUEUE_NAME, { connection });
export const trxEvents = new QueueEvents(QUEUE_NAME, { connection });

trxEvents.on('waiting', ({ jobId }) => {
  console.log(`📥 Job waiting: ${jobId}`);
});
trxEvents.on('active', ({ jobId }) => {
  console.log(`⚙️  Job active: ${jobId}`);
});
trxEvents.on('completed', ({ jobId }) => {
  console.log(`✅ Job done: ${jobId}`);
});
trxEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`💥 Job failed: ${jobId} — ${failedReason}`);
});

/**
 * Graceful shutdown helper (optional)
 */
export async function closeQueues() {
  try {
    await Promise.allSettled([
      trxEvents.close(),
      trxScheduler.close(),
      trxQueue.close(),
      connection.quit(),
    ]);
    console.log('👋 Queues & Redis connection closed.');
  } catch (e) {
    console.error('Error while closing queues:', e);
  }
}

// If process is being terminated inside a service, try to close cleanly
process.on('SIGINT', closeQueues);
process.on('SIGTERM', closeQueues);
