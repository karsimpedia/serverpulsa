const express = require("express");
const app = express();
app.use(express.json());

app.post("/topup", (req, res) => {
  const { kode_produk, tujuan, ref_id } = req.body;

  // Simulasikan sukses atau gagal berdasarkan nomor
  const isSuccess = !tujuan.endsWith("9"); // kalau diakhiri angka 9 → gagal

  console.log("🔌 Dummy supplier menerima:", req.body);

  res.json({
    ref_id,
    status: isSuccess ? "sukses" : "gagal",
    trx_id: "MOCK1234567890",
    message: isSuccess ? "Transaksi berhasil" : "Transaksi gagal",
    code: isSuccess ? "00" : "99"
  });
});

const PORT = process.env.MOCK_PORT || 5001;
app.listen(PORT, () => {
  console.log(`📡 Dummy Supplier API running on http://localhost:${PORT}`);
});
