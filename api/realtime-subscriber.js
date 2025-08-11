// api/realtime-subscriber.js
import Redis from 'ioredis';
import { emitStats } from './controllers/monitor.js';

export function setupRealtimeBridge(nsp) {
  const sub = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB || 0),
  });
  const channel = process.env.RT_CHANNEL || 'trx_events';

  sub.subscribe(channel, (err) => {
    if (err) console.error('Redis subscribe error:', err?.message || err);
    else console.log(`🔌 Realtime bridge subscribed: ${channel}`);
  });

  sub.on('message', async (_chan, message) => {
    try {
      const { evt, payload } = JSON.parse(message);
      if (evt === 'trx:new' || evt === 'trx:update') {
        nsp.to('admin').emit(evt, payload);
      } else if (evt === 'stats:refresh') {
        await emitStats(nsp); // hitung via Prisma dan emit "stats:update"
      }
    } catch (e) {
      console.error('Bridge message error:', e?.message || e);
    }
  });

  return sub;
}
