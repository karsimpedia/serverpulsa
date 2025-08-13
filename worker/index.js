// worker/index.js
import 'dotenv/config';
import { createTrxWorker } from '../queues.js';   // ⬅️ PENTING: import helper
import { processTopup } from './ops/processTopup.js';
import { processPayBill } from './ops/processPayBill.js';
import { processInquiryBill } from './ops/processInquiryBill.js';

const trxWorker = createTrxWorker(async (job) => {
  const { op, trxId } = job.data || {};
  if (!op || !trxId) throw new Error('Job data invalid (op & trxId wajib)');

  switch (op) {
    case 'topup':
      return processTopup(trxId);
    case 'paybill':
      return processPayBill(trxId);
    case 'inquirybill':
    case 'inquirytrx':
      return processInquiryBill(trxId);
    default:
      throw new Error(`Unknown op: ${op}`);
  }
});

trxWorker.on('completed', (job) => {
  console.log(`✅ [trx] job#${job.id} (${job.data.op}) selesai`);
});

trxWorker.on('failed', (job, err) => {
  console.error(`💥 [trx] job#${job?.id} (${job?.data?.op}) gagal:`, err?.stack || err);
});

export default trxWorker;
