// api/socket.js
import { Server } from "socket.io";

// sanitizer biar BigInt aman
function sanitize(obj) {
  return JSON.parse(JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? Number(v) : v)));
}

export function setupSocketIOServer(httpServer, allowedOrigins = ["http://localhost:3001"]) {
  const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, credentials: true, methods: ["GET", "POST"] },
    transports: ["websocket", "polling"],
    pingInterval: 20000,
    pingTimeout: 25000,
  });

  const nsp = io.of("/transactions");
  nsp.on("connection", (socket) => {
    socket.join("admin");
    socket.emit("connected", { ok: true, ts: Date.now(), sid: socket.id });
    socket.on("subscribe:reseller", (id) => id && socket.join(`reseller:${id}`));
    socket.on("unsubscribe:reseller", (id) => id && socket.leave(`reseller:${id}`));
    socket.on("subscribe:trx", (id) => id && socket.join(`trx:${id}`));
    socket.on("unsubscribe:trx", (id) => id && socket.leave(`trx:${id}`));
  });

  // helper emit
  function emitTrxNew(payload) {
    const data = sanitize(payload);
    nsp.emit("trx:new", data);
    if (data?.resellerId) nsp.to(`reseller:${data.resellerId}`).emit("trx:new", data);
    if (data?.id) nsp.to(`trx:${data.id}`).emit("trx:new", data);
  }
  function emitTrxUpdate(payload) {
    const data = sanitize(payload);
    nsp.emit("trx:update", data);
    if (data?.resellerId) nsp.to(`reseller:${data.resellerId}`).emit("trx:update", data);
    if (data?.id) nsp.to(`trx:${data.id}`).emit("trx:update", data);
  }

  return { io, nsp, emitTrxNew, emitTrxUpdate };
}
