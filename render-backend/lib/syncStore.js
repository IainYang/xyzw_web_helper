import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * 跨端同步码（一次性）。
 *
 * 场景：电脑端勾选账号 → 生成 32 位同步码 → 手机端输入码导入。
 *
 * 设计取舍：
 * - token 本来只存前端 localStorage，这里为了中转，会在服务器内存里**临时**放一份；
 * - 落盘也是加密的（AES-256-GCM，密钥从 AUTH_SECRET 派生），且默认 10 分钟过期；
 * - 一次性：redeem 成功立刻删除；
 * - 绑定账号：码只能被同一个用户名兑换，别人拿到码也没用。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SYNC_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "sync-codes.json");

/** 有效期：10 分钟 */
export const TTL_MS = 10 * 60 * 1000;
/** 同时最多保留多少个待兑换的码，防止内存被刷 */
const MAX_CODES = 200;
/** 单个码里最多几个账号 */
const MAX_TOKENS = 100;
/** 单个码里所有 BIN（base64）的总长度上限，防止把落盘文件撑爆 */
const MAX_BIN_CHARS = 5 * 1024 * 1024;
/** 兑换失败次数上限（按用户名），超过后一段时间内拒绝 */
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 10 * 60 * 1000;

const SECRET = process.env.AUTH_SECRET || "xyzw-dev-sync-secret";
const KEY = crypto.scryptSync(SECRET, "xyzw-sync-v1", 32);

/** code → { username, iv, tag, data, createdAt, expiresAt } */
const codes = new Map();
/** username → { count, firstAt } */
const fails = new Map();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function persist() {
  try {
    ensureDir();
    const obj = Object.fromEntries(codes);
    fs.writeFileSync(FILE, JSON.stringify(obj), { encoding: "utf8", mode: 0o600 });
  } catch {
    /* 落盘失败不影响内存里的码可用 */
  }
}

function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const obj = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const now = Date.now();
    for (const [code, item] of Object.entries(obj)) {
      if (item?.expiresAt > now) codes.set(code, item);
    }
  } catch {
    /* 文件损坏就当空 */
  }
}

load();

// 每分钟清一次过期
const timer = setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [code, item] of codes) {
    if (item.expiresAt <= now) {
      codes.delete(code);
      changed = true;
    }
  }
  for (const [user, rec] of fails) {
    if (now - rec.firstAt > FAIL_WINDOW_MS) fails.delete(user);
  }
  if (changed) persist();
}, 60 * 1000);
timer.unref?.();

function encrypt(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decrypt(item) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    KEY,
    Buffer.from(item.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(item.tag, "base64"));
  const raw = Buffer.concat([
    decipher.update(Buffer.from(item.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(raw.toString("utf8"));
}

/**
 * 归一化：只保留必要字段，丢掉本地状态（createdAt / lastUsed 等）。
 * 注意 BIN（base64）要保留：新设备刷新 token 靠它。
 */
function pickToken(t) {
  return {
    id: t.id,
    name: t.name,
    token: t.token,
    wsUrl: t.wsUrl ?? null,
    server: t.server ?? "",
    remark: t.remark ?? "",
    importMethod: t.importMethod ?? "manual",
    avatar: t.avatar ?? "",
    serverId: t.serverId ?? null,
    roleId: t.roleId ?? null,
    roleIndex: t.roleIndex ?? null,
    // combUser 是「长期有效」账号刷新 token 的关键，必须一起带走，
    // 否则新设备上点刷新只能落到「缺少本地 BIN」那条兜底提示
    combUser: t.combUser ?? null,
    // BIN（base64）同理：wxQrcode / bin / mobile 导入的账号，刷新要靠
    // IndexedDB 里这份原始 BIN 重新换取 token。新设备的 IndexedDB 是空的，
    // 只同步 token 字符串会让「刷新」直接报缺 BIN，所以原样带上。
    bin: typeof t.bin === "string" && t.bin ? t.bin : null,
    sourceUrl: t.sourceUrl ?? null,
    upgradedToPermanent: Boolean(t.upgradedToPermanent),
    upgradedAt: t.upgradedAt ?? null,
    updatedAt: t.updatedAt ?? null,
  };
}

export class SyncError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * 生成同步码。
 * @param {string} username 当前登录用户
 * @param {Array} tokens 要同步的账号
 * @returns {{code: string, expiresAt: string, count: number}} 同步码、到期时间与账号数量
 */
export function createSyncCode(username, tokens) {
  if (!username) throw new SyncError("未登录", 401);
  const list = Array.isArray(tokens) ? tokens : [];
  if (!list.length) throw new SyncError("没有要同步的账号");
  if (list.length > MAX_TOKENS) {
    throw new SyncError(`一次最多同步 ${MAX_TOKENS} 个账号`);
  }
  const cleaned = list.map(pickToken).filter((t) => t.token);
  if (!cleaned.length) throw new SyncError("账号数据里没有 token");

  const binChars = cleaned.reduce((sum, t) => sum + (t.bin?.length || 0), 0);
  if (binChars > MAX_BIN_CHARS) {
    throw new SyncError("同步数据过大，请减少勾选的账号后重试");
  }

  // 清掉过期的，再检查容量
  const now = Date.now();
  for (const [code, item] of codes) {
    if (item.expiresAt <= now) codes.delete(code);
  }
  if (codes.size >= MAX_CODES) {
    throw new SyncError("待兑换的同步码过多，请稍后再试", 429);
  }

  const code = crypto.randomBytes(16).toString("hex").toUpperCase();
  const payload = encrypt({ tokens: cleaned });
  const expiresAt = now + TTL_MS;
  codes.set(code, {
    username,
    ...payload,
    createdAt: now,
    expiresAt,
  });
  persist();
  return {
    code,
    expiresAt: new Date(expiresAt).toISOString(),
    count: cleaned.length,
  };
}

function tooManyFails(username) {
  const rec = fails.get(username);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > FAIL_WINDOW_MS) {
    fails.delete(username);
    return false;
  }
  return rec.count >= MAX_FAILS;
}

function markFail(username) {
  const rec = fails.get(username);
  if (!rec) {
    fails.set(username, { count: 1, firstAt: Date.now() });
  } else {
    rec.count += 1;
  }
}

function normalizeCode(code) {
  return String(code || "")
    .replace(/[\s-]/g, "")
    .trim()
    .toUpperCase();
}

/**
 * 查询同步码（不消费），用于导入前预览。
 * @param {string} code 同步码
 * @param {string} username 当前登录用户
 * @returns {{count: number, expiresAt: string, names: string[]}} 账号数量、到期时间与账号名
 */
export function peekSyncCode(code, username) {
  const key = normalizeCode(code);
  const item = codes.get(key);
  if (!item) throw new SyncError("同步码不存在或已使用，请重新生成", 404);
  if (item.expiresAt <= Date.now()) {
    codes.delete(key);
    persist();
    throw new SyncError("同步码已过期，请重新生成", 410);
  }
  if (item.username !== username) {
    markFail(username);
    throw new SyncError("同步码不属于当前账号", 403);
  }
  const { tokens } = decrypt(item);
  return {
    count: tokens.length,
    expiresAt: new Date(item.expiresAt).toISOString(),
    names: tokens.map((t) => t.name).slice(0, 20),
  };
}

/**
 * 兑换同步码（一次性，成功后立即删除）。
 * @param {string} code 同步码
 * @param {string} username 当前登录用户
 * @returns {{tokens: Array}} 同步过来的账号列表
 */
export function redeemSyncCode(code, username) {
  if (tooManyFails(username)) {
    throw new SyncError("尝试次数过多，请 10 分钟后再试", 429);
  }
  const key = normalizeCode(code);
  if (!key) throw new SyncError("请输入同步码");
  if (key.length !== 32) {
    markFail(username);
    throw new SyncError("同步码应为 32 位");
  }

  const item = codes.get(key);
  if (!item) {
    markFail(username);
    throw new SyncError("同步码不存在或已使用，请重新生成", 404);
  }
  if (item.expiresAt <= Date.now()) {
    codes.delete(key);
    persist();
    throw new SyncError("同步码已过期，请重新生成", 410);
  }
  if (item.username !== username) {
    markFail(username);
    throw new SyncError("同步码不属于当前账号", 403);
  }

  const { tokens } = decrypt(item);
  codes.delete(key);
  persist();
  fails.delete(username);
  return { tokens };
}
