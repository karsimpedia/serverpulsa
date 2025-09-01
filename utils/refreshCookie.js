// utils/refreshCookie.ts
export const REFRESH_COOKIE = process.env.REFRESH_COOKIE || "rtid";

export function setRefreshCookie(res, sid, maxAgeSec) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie(REFRESH_COOKIE, sid, {
    httpOnly: true,
    secure: isProd,                 // wajib true bila HTTPS/production
    sameSite: isProd ? "none" : "lax", // beda domain → "none" + HTTPS
    path: "/",
    maxAge: maxAgeSec * 1000,
  });
}

export function clearRefreshCookie(res) {
  const isProd = process.env.NODE_ENV === "production";
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
  });
}
