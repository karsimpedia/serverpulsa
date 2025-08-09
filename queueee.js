// queues.js
import 'dotenv/config';
import { Queue, QueueEvents, RedisConnection } from 'bullmq';

// ── Build Redis connection (mendukung REDIS_URL atau HOST/PORT)
function buildRedisConnection() {
  const url = process.env.REDIS_URL;
  if (url && url.trim()) {
    const u = new URL(url);
    return new RedisConnection({
      host: u.hostname,
      port: Number(u.port || 6379),
      username: u.username || undefined,
      password: u.password || undefined,
      db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : undefined,
      tls: u.protocol === 'rediss:' ? {} : undefined, // aktifkan TLS kalau pakai rediss://
    });
  }
  return new RedisConnection({
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT || 6379),
    // password: process.env.REDIS_PASSWORD,
  });
}

// ── Singleton biar gak duplikat saat hot-reload
const g = globalThis;
if (!g.__pulsaQueues) {
  const connection = buildRedisConnection();
  const QUEUE_NAME = process.env.QUEUE_NAME || 'trxQueue';

  const trxQueue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 1,
      // backoff: { type: 'exponential', delay: 2000 },
    },
  });

  const trxEvents = new QueueEvents(QUEUE_NAME, { connection });

  // (Opsional) logging event dasar
  trxEvents.on('completed', ({ jobId }) => {
    console.log(`[QueueEvents] Job ${jobId} completed`);
  });
  trxEvents.on('failed', ({ jobId, failedReason }) => {
    console.error(`[QueueEvents] Job ${jobId} failed: ${failedReason}`);
  });

  // ── Graceful shutdown
  let closing = false;
  async function closeQueues() {
    if (closing) return;
    closing = true;
    await Promise.allSettled([trxEvents.close(), trxQueue.close(), connection.quit()]);
  }

  // ── Helper enqueue
  async function enqueueDispatch(trxId) {
    return trxQueue.add('dispatch', { trxId });
  }
  async function enqueueDispatchPaybill(trxId) {
    return trxQueue.add('dispatch_paybill', { trxId });
  }
  async function enqueuePollInquiry(trxId, delayMs = 10_000) {
    return trxQueue.add('poll_inquiry', { trxId }, { delay: delayMs });
  }

  g.__pulsaQueues = {
    connection,
    QUEUE_NAME,
    trxQueue,
    trxEvents,
    closeQueues,
    enqueueDispatch,
    enqueueDispatchPaybill,
    enqueuePollInquiry,
  };
}

// ── Exports
export const {
  connection,
  QUEUE_NAME,
  trxQueue,
  trxEvents,
  closeQueues,
  enqueueDispatch,
  enqueueDispatchPaybill,
  enqueuePollInquiry,
} = g.__pulsaQueues;

// ── Auto-close on signals
process.on('SIGINT', async () => {
  console.log('SIGINT received. Closing queues…');
  await closeQueues();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Closing queues…');
  await closeQueues();
  process.exit(0);
});
