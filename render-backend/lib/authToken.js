import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import process from "node:process";

/**
 * 用户会话 token：HMAC-SHA256 签名的自包含 token（data.signature）。
 *
 * 不引入 jsonwebtoken，避免额外依赖；结构与 JWT 类似但不带 header 段。
 * 密钥取 AUTH_SECRET，未配置时用固定开发密钥（生产环境请务必设置）。
 */

const SECRET = process.env.AUTH_SECRET || "xyzw-local-auth-secret";
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

function sign(data) {
  return crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
}

/**
 * 生成 token。
 * @param {{username: string, role: string}} payload 用户信息
 * @param {number} [ttlMs] 有效期
 * @returns {string} data.signature
 */
export function signToken(payload, ttlMs = DEFAULT_TTL) {
  const body = {
    username: payload.username,
    role: payload.role || "user",
    iat: Date.now(),
    exp: Date.now() + ttlMs,
  };
  const data = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return `${data}.${sign(data)}`;
}

/**
 * 校验 token。
 * @param {string} token
 * @returns {object|null} 有效时返回 payload，否则 null
 */
export function verifyToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const [data, sig] = raw.split(".");
  if (!data || !sig) return null;

  const expected = sign(data);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!payload?.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 从请求里取用户 token（与 API Key 的 Authorization 分开，避免互相覆盖） */
export function readUserToken(req) {
  return req.header("x-user-token") || "";
}

/** 取客户端 IP（考虑反向代理） */
export function clientIp(req) {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

export { DEFAULT_TTL };
