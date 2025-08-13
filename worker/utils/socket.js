// worker/utils/socket.js
// Placeholder agar pemanggilan aman meskipun Socket.IO belum dipasang
export function pushTrxUpdate(trxId, payload) {
  try {
    // contoh jika Anda punya singleton io:
    // import { io } from '../../api/socket.js';
    // io.to(`trx:${trxId}`).emit('trx:update', { trxId, ...payload });
    // atau broadcast via channel global:
    // io.emit('trx:update', { trxId, ...payload });

    // sementara hanya log:
    console.log('[socket] trx:update', trxId, payload);
  } catch (e) {
    // jangan ganggu alur worker
  }
}
