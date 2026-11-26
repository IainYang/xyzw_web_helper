import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * 登录相关审计日志。
 *
 * 落盘到 render-backend/logs/auth-YYYY-MM-DD.log，每行一条 JSON：
 * { ts, action, username, ip, ua, ok, reason }
 *
 * action 取值：login / login_fail / logout / user_create / user_update / user_delete
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.AUTH_LOG_DIR || path.join(__dirname, "..", "logs");

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fileOf(date) {
  return path.join(LOG_DIR, `auth-${date || todayStr()}.log`);
}

/**
 * 写一条审计日志。
 * @param {{action: string, username?: string, ip?: string, ua?: string, ok?: boolean, reason?: string}} entry
 */
export function logAuth(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action: entry.action,
      username: entry.username || "",
      ip: entry.ip || "",
      ua: (entry.ua || "").slice(0, 200),
      ok: entry.ok !== false,
      reason: entry.reason || "",
    });
    fs.appendFileSync(fileOf(), `${line}\n`);
  } catch {
    // 日志失败不能影响主流程
  }
}

/**
 * 读取某天的日志（新的在前）。
 * @param {{date?: string, limit?: number}} options
 */
export function readAuthLogs({ date, limit = 500 } = {}) {
  const file = fileOf(date);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const rows = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return rows.reverse().slice(0, Math.min(limit, 2000));
  } catch {
    return [];
  }
}

/** 列出有日志的日期（新的在前），用于前端切换 */
export function listAuthLogDates() {
  try {
    return fs
      .readdirSync(LOG_DIR)
      .filter((f) => /^auth-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .map((f) => f.replace(/^auth-|\.log$/g, ""))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
