const { Worker } = require('bullmq');
const Redis = require('ioredis');

const redisOptions = {
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,
};

const connection = new Redis(redisOptions);

const worker = new Worker('pulsa', async job => {
  console.log('📥 Memproses job:', job.name, job.data);

  // contoh logika kerja
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('✅ Job selesai:', job.id);
}, { connection });

worker.on('failed', (job, err) => {
  console.error('❌ Job gagal:', job.id, err.message);
});
