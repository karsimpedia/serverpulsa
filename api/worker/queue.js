// api/queues.js
import { Queue } from 'bullmq';
import Redis from 'ioredis';

// Pakai env atau default (cocok untuk Docker: redis://redis:6379)
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

// Satu koneksi Redis untuk seluruh app (API & Worker import dari sini)
export const connection = new Redis(REDIS_URL, {
  // Supaya BullMQ nggak kena retry-per-request limit di ioredis
  maxRetriesPerRequest: null,
});

// Antrian utama transaksi pulsa
export const trxQueue = new Queue('trx', {
  connection,
  defaultJobOptions: {
    // Biar queue nggak numpuk sampah job selesai/gagal
    removeOnComplete: true,
    removeOnFail: true,
    // attempts default 1 (retry diatur khusus per job kalo perlu)
    attempts: 1,
  },
});

// (Opsional) helper untuk enqueue dari mana saja
export async function enqueueDispatch(trxId) {
  return trxQueue.add('dispatch', { trxId });
}

// Graceful shutdown (opsional, kalau kamu mau panggil saat SIGTERM/SIGINT)
// export async function shutdownQueues() {
//   await trxQueue.close();
//   await connection.quit();
// }
