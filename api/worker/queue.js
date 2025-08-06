// FILE: api/worker/queue.js
const { Queue } = require("bullmq");
const topupQueue = new Queue("topup", {
  connection: {
    host: "redis",
    port: 6379,
  },
}); 

module.exports = topupQueue;
