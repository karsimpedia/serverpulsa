const express = require('express');
const { pulsaQueue } = require('../queue/queue');
const { Job } = require('bullmq');

const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');

// Setup BullBoard
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

const { addQueue, removeQueue, setQueues } = createBullBoard({
  queues: [new BullMQAdapter(pulsaQueue)],
  serverAdapter,
});

const app = express();
app.use(express.json());

// Mount dashboard
app.use('/admin/queues', serverAdapter.getRouter());

// Buat topup baru
app.post('/topup', async (req, res) => {
  const { nomor, nominal } = req.body;
  if (!nomor || !nominal) return res.status(400).json({ error: 'Nomor dan nominal wajib' });

  const job = await pulsaQueue.add('topup', { nomor, nominal }, {
    attempts: 3,
    backoff: { type: 'fixed', delay: 5000 },
  });

  res.json({ message: 'Transaksi ditambahkan', jobId: job.id });
});

// Resend manual
app.post('/resend/:id', async (req, res) => {
  const job = await pulsaQueue.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job tidak ditemukan' });

  const newJob = await pulsaQueue.add('topup', job.data, {
    attempts: 3,
    backoff: { type: 'fixed', delay: 5000 },
  });

  res.json({ message: 'Job dikirim ulang', newJobId: newJob.id });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log('🚀 API jalan di http://localhost:' + PORT);
  console.log(`📊 Dashboard BullBoard: http://localhost:${PORT}/admin/queues`);
});
