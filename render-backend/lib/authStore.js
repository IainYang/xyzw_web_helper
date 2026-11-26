import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * 白名单用户存储。
 *
 * 数据落在 render-backend/whitelist.json，结构：
 * {
 *   "users": [
 *     { username, passHash, salt, role: "admin"|"user", enabled, note,
 *       createdAt, lastLoginAt, lastLoginIp }
 *   ]
 * }
 *
 * 密码用 scrypt + 每用户独立 salt 存哈希，不存明文。
 * 文件不存在时会自动初始化，并写入 .env 里的 ADMIN_USER / ADMIN_PASSWORD（若有）。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.AUTH_DATA_DIR || path.join(__dirname, "..");
const USERS_FILE = path.join(DATA_DIR, "whitelist.json");

const SCRYPT_KEYLEN = 64;

function emptyStore() {
  return { users: [] };
}

function load() {
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.users)) return parsed;
    return emptyStore();
  } catch {
    return emptyStore();
  }
}

function save(store) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  const tmp = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, USERS_FILE);
}

/** 首次启动时按 .env 的 ADMIN_USER / ADMIN_PASSWORD 建一个管理员 */
function ensureBootstrapUser() {
  const store = load();
  if (store.users.length) return store;

  const username = (process.env.ADMIN_USER || "").trim();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!username || !password) return store;

  store.users.push(buildUser({ username, password, role: "admin", note: "初始管理员" }));
  save(store);
  return store;
}

function buildUser({ username, password, role = "user", note = "" }) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    username,
    passHash: hashPassword(password, salt),
    salt,
    role,
    enabled: true,
    note,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
    lastLoginIp: null,
  };
}

export function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString("hex");
}

/** 密码比对使用定长比较，避免长度侧信道 */
export function verifyPassword(user, password) {
  if (!user?.passHash || !user?.salt) return false;
  const expected = Buffer.from(user.passHash, "hex");
  const actual = Buffer.from(hashPassword(password, user.salt), "hex");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/** 对外返回时去掉哈希与 salt */
export function publicUser(user) {
  if (!user) return null;
  const rest = { ...user };
  delete rest.passHash;
  delete rest.salt;
  return rest;
}

export function listUsers() {
  return load().users.map(publicUser);
}

export function findUser(username) {
  const name = String(username || "").trim();
  if (!name) return null;
  return load().users.find((u) => u.username === name) || null;
}

export function hasAnyUser() {
  return load().users.length > 0;
}

export function createUser({ username, password, role = "user", note = "" }) {
  const name = String(username || "").trim();
  if (!name) throw new Error("用户名不能为空");
  if (!/^[\w.@-]{2,32}$/.test(name)) {
    throw new Error("用户名只能包含字母、数字、下划线、点、@、短横线，长度 2-32");
  }
  if (String(password || "").length < 6) throw new Error("密码至少 6 位");

  const store = load();
  if (store.users.some((u) => u.username === name)) {
    throw new Error("该用户已存在");
  }
  const user = buildUser({ username: name, password, role, note });
  store.users.push(user);
  save(store);
  return publicUser(user);
}

export function updateUser(username, patch = {}) {
  const name = String(username || "").trim();
  const store = load();
  const user = store.users.find((u) => u.username === name);
  if (!user) throw new Error("用户不存在");

  if (typeof patch.enabled === "boolean") user.enabled = patch.enabled;
  if (typeof patch.note === "string") user.note = patch.note.slice(0, 100);
  if (patch.role === "admin" || patch.role === "user") user.role = patch.role;
  if (patch.password) {
    if (String(patch.password).length < 6) throw new Error("密码至少 6 位");
    user.salt = crypto.randomBytes(16).toString("hex");
    user.passHash = hashPassword(patch.password, user.salt);
  }

  save(store);
  return publicUser(user);
}

export function deleteUser(username) {
  const name = String(username || "").trim();
  const store = load();
  const before = store.users.length;
  store.users = store.users.filter((u) => u.username !== name);
  if (store.users.length === before) throw new Error("用户不存在");
  // 不允许把最后一个管理员删掉，否则没人能再管理
  if (!store.users.some((u) => u.role === "admin" && u.enabled)) {
    throw new Error("至少要保留一个启用的管理员");
  }
  save(store);
  return true;
}

/** 登录成功后记录时间与 IP */
export function touchLogin(username, ip) {
  const store = load();
  const user = store.users.find((u) => u.username === username);
  if (!user) return;
  user.lastLoginAt = new Date().toISOString();
  user.lastLoginIp = ip || null;
  save(store);
}

// 模块加载时就跑一次，保证首次部署能直接登录
ensureBootstrapUser();

export { USERS_FILE };
