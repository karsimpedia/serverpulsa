import prisma from "../prisma.js";

const onlyDigits = (s = "") => String(s).replace(/\D/g, "");

/**
 * Jika kategori punya prefix -> msisdn harus cocok salah satu.
 * Jika kategori TIDAK punya prefix -> true (boleh lanjut).
 */
export async function validateCategoryPrefix(msisdn, categoryId) {
  const num = onlyDigits(msisdn);
  if (!categoryId) return true; // jika produk tak berkategori, anggap lolos
  if (num.length < 3) return false;

  const cat = await prisma.productCategory.findUnique({
    where: { id: categoryId },
    include: { prefixes: true },
  });
  if (!cat) return false;

  if (!cat.prefixes || cat.prefixes.length === 0) return true;

  // longest-first
  const list = cat.prefixes.sort((a, b) => b.length - a.length);
  return list.some((p) => num.startsWith(p.prefix));
}
