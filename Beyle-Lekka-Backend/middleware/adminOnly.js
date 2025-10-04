export default function adminOnly(req, res, next) {
  const k = req.headers["x-admin-key"];
  const allowDev = process.env.NODE_ENV !== "production" && process.env.DEV_ADMIN_KEY && k === process.env.DEV_ADMIN_KEY;
  const allowJwt = req.user?.roles?.includes?.("superadmin");
  if (allowDev || allowJwt) return next();
  res.status(403).json({ error: "admin_only" });
}
