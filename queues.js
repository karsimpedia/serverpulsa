// queues.js
import 'dotenv/config';
import IORedis from 'ioredis';
import pkg from 'bullmq';

const { Queue, QueueEvents } = pkg;

export const QUEUE_NAME = 'trxQueue';

const redisUrl = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`;

export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});


export const trxQueue = new Queue(QUEUE_NAME, { connection });
export const trxEvents = new QueueEvents(QUEUE_NAME, { connection });

trxEvents.on('completed', ({ jobId }) => console.log(`✅ Job done: ${jobId}`));
trxEvents.on('failed', ({ jobId, failedReason }) => console.error(`💥 Job failed: ${jobId} — ${failedReason}`));

export async function closeQueues() {
  await Promise.allSettled([trxEvents.close(), trxScheduler.close(), trxQueue.close(), connection.quit()]);
  console.log('👋 Queues closed.');
}
process.on('SIGINT', closeQueues);
process.on('SIGTERM', closeQueues);
