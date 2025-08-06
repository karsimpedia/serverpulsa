// FILE: api/api.js
const express = require("express");
const { QueueEvents, Job } = require("bullmq");
const topupQueue = require("./worker/queue");
const { createBullBoard } = require("@bull-board/api");
const { BullMQAdapter } = require("@bull-board/api/bullMQAdapter");
const { ExpressAdapter } = require("@bull-board/express");

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");

createBullBoard({
  queues: [new BullMQAdapter(topupQueue)],
  serverAdapter,
});

const app = express();
app.use(express.json());
const apitopup = require("./routes/topup");
const resellerRoutes = require("./routes/reseller");
const product = require("./routes/product");
app.use("/admin/queues", serverAdapter.getRouter());
app.use("/api", apitopup);
app.use("/users",  resellerRoutes);
app.use("/product",  product);

app.post("/resend/:id", async (req, res) => {
  const job = await topupQueue.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job tidak ditemukan" });

  const newJob = await topupQueue.add("send-topup", job.data, {
    attempts: 3,
    backoff: { type: "fixed", delay: 5000 },
  });

  res.json({ message: "Job dikirim ulang", newJobId: newJob.id });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log("🚀 API jalan di http://localhost:" + PORT);
  console.log(`📊 Dashboard BullBoard: http://localhost:${PORT}/admin/queues`);
});
