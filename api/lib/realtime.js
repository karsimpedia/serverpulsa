// api/lib/realtime.ts

export const sanitize = (obj) =>
  JSON.parse(JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? Number(v) : v)));

export function emitTrxNew(nsp, payload) {
  const data = sanitize(payload);
  nsp.emit("trx:new", data);
  if (data?.resellerId) nsp.to(`reseller:${data.resellerId}`).emit("trx:new", data);
  if (data?.id) nsp.to(`trx:${data.id}`).emit("trx:new", data);
}

export function emitTrxUpdate(nsp, payload) {
  const data = sanitize(payload);
  nsp.emit("trx:update", data);
  if (data?.resellerId) nsp.to(`reseller:${data.resellerId}`).emit("trx:update", data);
  if (data?.id) nsp.to(`trx:${data.id}`).emit("trx:update", data);
}