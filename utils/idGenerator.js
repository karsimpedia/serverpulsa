// utils/idGenerator.js

import prisma from "../api/prisma";


export async  function generateResellerId() {
  const count = await prisma.reseller.count(); // hitung total reseller
  const nextNumber = count + 1;
  const formatted = String(nextNumber).padStart(4, "0");
  return `LA${formatted}`; // hasil: LA0001, LA0002, dst
}


