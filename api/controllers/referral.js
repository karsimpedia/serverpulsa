// api/controllers/referral.js
import prisma from "../prisma.js";

const normalize = (s) => String(s || "").trim().toUpperCase();
const isValidCode = (s) => /^[A-Z0-9_-]{4,64}$/.test(s);

export async function updateMyReferralCode(req, res) {
  const meId = req.reseller.id;         // dari authReseller
  const raw = req.body?.code ?? "";     // boleh kosong -> pakai id

  try {
    const me = await prisma.reseller.findUnique({
      where: { id: meId },
      select: { id: true, referralCode: true }
    });
    if (!me) return res.status(404).json({ error: "Reseller tidak ditemukan." });

    // Jika kosong → set ke ID reseller (UPPERCASE)
    const target = raw ? normalize(raw) : normalize(me.id);

    if (!isValidCode(target)) {
      return res.status(400).json({ error: "Kode hanya A-Z, 0-9, _ atau -, panjang 4–64." });
    }

    // Kalau sama persis dengan sekarang, langsung return OK
    if (me.referralCode && me.referralCode === target) {
      return res.json({ message: "Referral code tidak berubah.", data: { referralCode: target } });
    }

    // Cek unik (tanpa citext: kita pakai uppercase konsisten)
    const taken = await prisma.reseller.findFirst({
      where: { referralCode: target, NOT: { id: meId } },
      select: { id: true }
    });
    if (taken) {
      return res.status(409).json({ error: "Kode referral sudah dipakai reseller lain." });
    }

    const updated = await prisma.reseller.update({
      where: { id: meId },
      data: { referralCode: target },
      select: { id: true, name: true, referralCode: true }
    });

    return res.json({ message: "Referral code diperbarui.", data: updated });
  } catch (e) {
    console.error("updateMyReferralCode error:", e);
    return res.status(500).json({ error: "Gagal memperbarui referral code." });
  }
}
