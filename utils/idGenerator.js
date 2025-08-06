// utils/idGenerator.js
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function generateResellerId() {
  const count = await prisma.reseller.count(); // hitung total reseller
  const nextNumber = count + 1;
  const formatted = String(nextNumber).padStart(4, "0");
  return `LA${formatted}`; // hasil: LA0001, LA0002, dst
}

module.exports = generateResellerId;
