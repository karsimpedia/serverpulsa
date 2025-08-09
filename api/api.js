import express from "express";
import morgan from "morgan";
import dotenv from "dotenv";
dotenv.config();

import authReseller from "./middleware/authReseller.js";
import cookieParser from "cookie-parser";

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



const app = express();
app.use(cookieParser()); 
app.use(express.json());
app.use(morgan("dev"));

// Bull Board (gantikan AdminJS)
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/bull");
createBullBoard({
  queues: [new BullMQAdapter(trxQueue)],
  serverAdapter,
});
app.use("/bull", serverAdapter.getRouter());
app.use("/api/auth", authRoutes);
app.use("/api/topup",  routerTopup);
app.use("/api/trx", trxDetailRoutes);
// Routes transaksi (dashboard + list + stream)
app.use("/api/transactions", transactionRoutes);
app.use("/api/reseller", routeReseller);
app.use("/api/commission/rules", authReseller, routerCommisson);
app.use("/api/products", routerProduct);
app.use("/api/suppliers", routerSuplier);
app.use("/api/referral", referralRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/category", categoryRoutes);
app.post("/api/admin/reseller/:id/parent", async (req, res) => {
  const { id } = req.params;
  const { parentId } = req.body;
  if (id === parentId)
    return res.status(400).json({ error: "Tidak boleh parent diri sendiri" });
  // (opsional) validasi anti loop…
  const upd = await prisma.reseller.update({
    where: { id },
    data: { parentId },
  });
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API listening on", PORT));
