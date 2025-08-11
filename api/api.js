// api/api.js
import "dotenv/config";
import express from "express";
import http from "node:http";
import morgan from "morgan";
import cors from "cors";
import cookieParser from "cookie-parser";

import prisma from "./prisma.js";
import { setupSocketIOServer } from "./socket.js";
import { setupRealtimeBridge } from "./realtime-subscriber.js";

import monitorRoutes from "./routes/monitor.js";         // ← untuk /api/admin/transactions & /stats
import authReseller from "./middleware/authReseller.js";
import routerTopup from "./routes/topup.js";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter.js";
import { ExpressAdapter } from "@bull-board/express";
import { trxQueue } from "../queues.js";
import routerCommisson from "./routes/commission.js";
import routerProduct from "./routes/product.js";
import routeReseller from "./routes/reseller.js";
import routerSuplier from "./routes/supplier.js";
import transactionRoutes from "./routes/transaction.js";
import billingRoutes from "./routes/billing.js";
import referralRoutes from "./routes/referral.js";
import trxDetailRoutes from "./routes/transactionDetail.js";
import categoryRoutes from "./routes/category.js";
import authRoutes from "./routes/auth.js";
import adminRoute from "./routes/admin.js";

const app = express();

/** =========================
 *  CORS — pasang PALING AWAL
 *  ======================== */
const allowedOrigins = (
  process.env.DASHBOARD_ORIGINS || process.env.DASHBOARD_ORIGIN || "http://localhost:3001"
)
  .split(",")
  .map((s) => s.trim());

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // allow curl/postman
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "x-api-key",
    "x-user-id",
    "x-user-email",
    "x-user-username",
  ],
  exposedHeaders: ["x-user-id", "x-user-email", "x-user-username"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // preflight

/** =========================
 *  Middleware standar
 *  ======================== */
app.use(cookieParser());
app.use(express.json());
app.use(morgan("dev"));

/** =========================
 *  Socket.IO + Redis bridge
 *  ======================== */
const server = http.createServer(app);

// kalau setupSocketIOServer menerima allowedOrigins, pass di sini
const { io, nsp } = setupSocketIOServer(server, allowedOrigins);
app.locals.io = io;
app.locals.trxNsp = nsp;
setupRealtimeBridge(nsp);

/** =========================
 *  Bull Board (opsional: lindungi auth)
 *  ======================== */
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/bull");
createBullBoard({
  queues: [new BullMQAdapter(trxQueue)],
  serverAdapter,
});
app.use("/bull", serverAdapter.getRouter());

/** =========================
 *  Routes
 *  ======================== */
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoute);
app.use("/api/admin", monitorRoutes);           // ← penting: aktifkan monitor (transactions & stats)
app.use("/api/topup", routerTopup);
app.use("/api/trx", trxDetailRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/reseller", routeReseller);
app.use("/api/commission/rules", authReseller, routerCommisson);
app.use("/api/products", routerProduct);
app.use("/api/suppliers", routerSuplier);
app.use("/api/referral", referralRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/category", categoryRoutes);

/** =========================
 *  Admin utilities
 *  ======================== */
app.post("/api/admin/reseller/:id/parent", async (req, res) => {
  const { id } = req.params;
  const { parentId } = req.body;
  if (id === parentId) return res.status(400).json({ error: "Tidak boleh parent diri sendiri" });
  const upd = await prisma.reseller.update({ where: { id }, data: { parentId } });
  res.json(upd);
});

app.post("/api/admin/commission/assign", async (req, res) => {
  const { resellerId, planId } = req.body;
  const row = await prisma.commissionPlanAssignment.upsert({
    where: { resellerId },
    update: { planId },
    create: { resellerId, planId },
  });
  res.json(row);
});

app.post("/api/admin/reseller-price", async (req, res) => {
  const { resellerId, productId, sellPrice } = req.body;
  const row = await prisma.resellerPrice.upsert({
    where: { resellerId_productId: { resellerId, productId } },
    update: { sellPrice: BigInt(sellPrice) },
    create: { resellerId, productId, sellPrice: BigInt(sellPrice) },
  });
  res.json({ ...row, sellPrice: Number(row.sellPrice) });
});

/** =========================
 *  Start server
 *  ======================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("API listening on", PORT));
