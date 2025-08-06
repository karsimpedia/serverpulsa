const express = require("express");

const generateResellerId = require("../../utils/idGenerator");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const bcrypt = require("bcrypt");
const api= {}
// Fungsi generate ID dengan prefix "LA" + 4 digit acak dan pastikan unik
// async function generateUniqueResellerId() {
//   let unique = false;
//   let id = "";

//   while (!unique) {
//     const random = Math.floor(1000 + Math.random() * 9000); // 4 digit acak
//     id = `LA${random}`;
//     const existing = await prisma.reseller.findUnique({ where: { id } });
//     if (!existing) unique = true;
//   }

//   return id;
// }

api.reseller  = async (req, res) => {
  try {
    const { name, username, password, parentId } = req.body;

    if (!name || !username || !password) {
      return res.status(400).json({ error: "Semua field wajib diisi." });
    }

    const existingUsername = await prisma.reseller.findUnique({
      where: { username },
    });
    if (existingUsername) {
      return res.status(400).json({ error: "Username sudah digunakan." });
    }
   const id = await generateResellerId();
    // const id = await generateUniqueResellerId();
    const hashedPassword = await bcrypt.hash(password, 10);

    const reseller = await prisma.reseller.create({
      data: {
        id,
        name,
        username,
        password: hashedPassword,
        parentId: parentId || null,
        saldo: 0,
      },
    });

    res.json({
      message: "Registrasi berhasil.",
      reseller: {
        id: reseller.id,
        name: reseller.name,
        username: reseller.username,
        parentId: reseller.parentId,
        saldo: reseller.saldo,
      },
    });
  } catch (err) {
    console.error("Registrasi gagal:", err);
    res.status(500).json({ error: "Terjadi kesalahan saat registrasi." });
  }
};

module.exports = api
