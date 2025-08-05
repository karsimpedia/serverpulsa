const { Queue } = require('bullmq');
const Redis = require('ioredis');

const redisOptions = {
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null, // wajib untuk BullMQ
};

const connection = new Redis(redisOptions);
const pulsaQueue = new Queue('pulsa', { connection });

module.exports = { pulsaQueue, connection };
