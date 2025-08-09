import jwt from "jsonwebtoken";

const COOKIE_NAME = process.env.COOKIE_NAME || "token";
const JWT_SECRET  = process.env.JWT_SECRET || "change-this";

export function authJwt(req, res, next) {
  try {
    const bearer = req.headers.authorization?.split(" ")[1];
    const cookieToken = req.cookies?.[COOKIE_NAME];
    const token = bearer || cookieToken;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const payload = jwt.verify(token, JWT_SECRET);
    // payload: { id, role, resellerId? }
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Token invalid/expired" });
  }
}
