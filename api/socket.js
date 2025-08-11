// api/socket.js
import { Server } from "socket.io";

export function setupSocketIOServer(httpServer, allowedOrigins = ["http://localhost:3001"]) {
  const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, credentials: true },
  });
  const nsp = io.of("/transactions");
  nsp.on("connection", (socket) => {
    socket.join("admin");
    socket.emit("connected", { ok: true, ts: Date.now() });
  });
  return { io, nsp };
}
