const express = require("express");
const generateResellerId = require("../../utils/idGenerator");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const bcrypt = require("bcrypt");

const api = {};

api.reseller = async function registerReseller(req, res) {
  try {
    const { name, username, password, parentId, deviceType = "phone", deviceId } = req.body;

    if (!name || !username || !password || !deviceId) {
      return res.status(400).json({ error: "Semua field wajib diisi, termasuk deviceId." });
    }

    const existing = await prisma.reseller.findUnique({ where: { username } });
    if (existing) {
      return res.status(409).json({ error: "Username sudah digunakan." });
    }

    if (parentId) {
      const parent = await prisma.reseller.findUnique({ where: { id: parentId } });
      if (!parent) {
        return res.status(400).json({ error: "Upline (parentId) tidak valid." });
      }
    }

    const id = await generateResellerId();
    const hashedPassword = await bcrypt.hash(password, 10);

    const newReseller = await prisma.reseller.create({
      data: {
        id,
        name,
        username,
        password: hashedPassword,
        parentId: parentId || null,
        devices: {
          create: {
            deviceType,
            deviceId,
          },
        },
      },
    });

    // Ambil semua produk dan isi harga jual default
    const products = await prisma.product.findMany();

    for (const product of products) {
      const harga = Number(product.basePrice) + 100;
      await prisma.hargaJual.create({
        data: {
          resellerId: newReseller.id,
          productId: product.id,
          price: harga,
        },
      });
    }

    return res.json({ message: "Registrasi berhasil", resellerId: newReseller.id });
  } catch (err) {
    console.error("Registrasi gagal:", err);
    res.status(500).json({ error: "Terjadi kesalahan saat registrasi." });
  }
};

api.resellerList = async function getAllResellers(req, res) {
  try {
    const resellers = await prisma.reseller.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        username: true,
        saldo: true,
        parentId: true,
        createdAt: true,
        parent: {
          select: { id: true, name: true },
        },
        devices: {
          select: {
            id: true,
            deviceType: true,
            deviceId: true,
          },
        },
      },
    });

    res.json({ data: resellers });
  } catch (err) {
    console.error("Gagal ambil data reseller:", err);
    res.status(500).json({ error: "Terjadi kesalahan." });
  }
};

module.exports = api;
