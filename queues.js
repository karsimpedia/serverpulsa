// queues.js
import { Queue,  QueueEvents, Worker } from 'bullmq';
import IORedis from 'ioredis';

// ---------- Redis connection factory ----------
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const isTLS = redisUrl.startsWith('rediss://') || String(process.env.REDIS_TLS).toLowerCase() === 'true';

// Opsi ioredis yang ramah BullMQ produksi
const baseRedisOpts = {
  maxRetriesPerRequest: null,     // biarkan BullMQ handle retry
  enableReadyCheck: true,
  lazyConnect: false,
  tls: isTLS ? {} : undefined
};

function createRedis() {
  return new IORedis(redisUrl, baseRedisOpts);
}

// Prefix queue (biar multi-env aman)
const prefix = process.env.BULL_PREFIX || 'pulsa';

// ---------- Dedicated connections ----------
const queueConn = createRedis();
const schedulerConn = createRedis();
const eventsConn = createRedis();

// ---------- Queue & Schedulers ----------
export const trxQueue = new Queue('trx', {
  connection: queueConn,
  prefix,
  defaultJobOptions: {
    attempts: Number(process.env.JOB_ATTEMPTS || 2),
    backoff: { type: 'exponential', delay: Number(process.env.JOB_BACKOFF_DELAY || 3000) },
    removeOnComplete: { age: 3600, count: 1000 },     // hapus job sukses >1 jam atau >1000 job
    removeOnFail: { age: 24 * 3600 }                  // hapus job gagal >24 jam
  }
});

// Catatan: di BullMQ v4 perlu QueueScheduler; cek versi Anda.


export const trxEvents = new QueueEvents('trx', {
  connection: eventsConn,
  prefix
});

// (Opsional) dengarkan event penting utk logging/monitor
trxEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`[trx] job ${jobId} failed:`, failedReason);
});
trxEvents.on('stalled', ({ jobId }) => {
  console.warn(`[trx] job ${jobId} stalled`);
});
trxEvents.on('completed', ({ jobId }) => {
  console.log(`[trx] job ${jobId} completed`);
});

// ---------- Helper buat bikin Worker ----------
export function createTrxWorker(processor, opts = {}) {
  const concurrency = Number(process.env.WORKER_CONCURRENCY || 5);
  return new Worker('trx', processor, {
    connection: createRedis(), // koneksi dedicated per worker
    prefix,
    concurrency,
    // limiter: { max: 100, duration: 1000 } // aktifkan kalau butuh rate-limit
  });
}

// ---------- Graceful shutdown ----------
async function shutdown() {
  try {
    await Promise.allSettled([
      trxEvents.close(),
      trxScheduler.close(),
      trxQueue.close()
    ]);
  } finally {
    await Promise.allSettled([
      queueConn.quit(),
      schedulerConn.quit(),
      eventsConn.quit()
    ]);
  }
}
process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });
