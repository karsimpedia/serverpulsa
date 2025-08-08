export const normalizeCode = (s) => String(s || "").trim().toUpperCase();
export const isValidCode = (s) => /^[A-Z0-9_-]{4,64}$/.test(s); // panjang beb