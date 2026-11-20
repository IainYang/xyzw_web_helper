/**
 * 解码游戏页 WebSocket 报文埋点
 *
 * 数据来源：public/game/ws-trace.js 录制 → /frontend-log → render-backend/logs/frontend-YYYY-MM-DD.log
 * 每个 ws 帧在日志里是一条 JSON：{ ts, level, message, page, meta: { dir, kind, b64|text, ws } }
 *
 * 用法：
 *   node tools/decode-frontend-ws.mjs                  # 最新日志，只看十殿相关（team/room/nightmare/match）
 *   node tools/decode-frontend-ws.mjs --all            # 全部帧
 *   node tools/decode-frontend-ws.mjs --grep "team_|room_" --all
 *   node tools/decode-frontend-ws.mjs --cmd team_create
 *   node tools/decode-frontend-ws.mjs --file render-backend/logs/frontend-2026-11-10.log
 *   node tools/decode-frontend-ws.mjs --stats          # 只出命令统计
 */
import fs from "node:fs";
import path from "node:path";
import { g_utils } from "../src/utils/bonProtocol.js";

const LOG_DIR = path.resolve(process.cwd(), "render-backend", "logs");

const args = process.argv.slice(2);

function takeOption(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

const showAll = args.includes("--all");
const statsOnly = args.includes("--stats");
const cmdFilter = takeOption("--cmd");
const grepFilter = takeOption("--grep");
const fileArg = takeOption("--file");
const sinceArg = takeOption("--since");

// --since 21:56 或 --since 21:56:30：只看这个本地时间之后的帧
let sinceTs = 0;
if (sinceArg) {
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(sinceArg);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), Number(hm[3] || 0), 0);
    sinceTs = d.getTime();
    console.log(`只统计 ${d.toLocaleString()} 之后的帧`);
  } else if (Number(sinceArg) > 0) {
    sinceTs = Number(sinceArg);
  }
}

function latestLogFile() {
  if (!fs.existsSync(LOG_DIR)) return null;
  const files = fs
    .readdirSync(LOG_DIR)
    .filter((name) => /^frontend-.*\.log$/.test(name))
    .map((name) => ({
      name,
      mtime: fs.statSync(path.join(LOG_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(LOG_DIR, files[0].name) : null;
}

function stringify(value) {
  return JSON.stringify(
    value,
    (key, val) =>
      typeof val === "bigint"
        ? val.toString()
        : val instanceof Uint8Array
          ? `<bytes ${val.length}>`
          : val,
    2,
  );
}

/** BON 解码器在读到不完整缓冲时会自己 console.log("read eof")，这里临时静音 */
function parseSilently(bytes) {
  const original = console.log;
  console.log = () => {};
  try {
    return g_utils.parse(bytes, "auto");
  } finally {
    console.log = original;
  }
}

function decodeFrame(meta) {
  if (!meta || !meta.dir) return null;
  if (meta.kind === "text") {
    try {
      return { cmd: "TEXT", body: JSON.parse(meta.text) };
    } catch {
      return { cmd: "TEXT", body: (meta.text || "").slice(0, 300) };
    }
  }
  if (meta.kind !== "bin" || !meta.b64) return null;
  const bytes = new Uint8Array(Buffer.from(meta.b64, "base64"));
  try {
    const msg = parseSilently(bytes);
    return {
      cmd: msg.cmd || msg.resp || "(无 cmd)",
      seq: msg.seq,
      ack: msg.ack,
      code: msg.code || undefined,
      body: msg.rawData ?? msg.body,
    };
  } catch (error) {
    return {
      cmd: "(解码失败)",
      body: `${error.message} | 前 16 字节: ${Buffer.from(
        bytes.slice(0, 16),
      ).toString("hex")}`,
    };
  }
}

const file = fileArg ? path.resolve(process.cwd(), fileArg) : latestLogFile();

if (!file || !fs.existsSync(file)) {
  console.error(
    "没有找到埋点日志。请确认 render-backend 已启动、游戏页已加载 ws-trace.js，且做过一次操作。",
  );
  process.exit(1);
}

const lines = fs
  .readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => line.trim());

console.log(`日志文件: ${file}`);
console.log(`日志行数: ${lines.length}`);

const matchedKeyword = grepFilter
  ? new RegExp(grepFilter, "i")
  : /team|room|nightmare|match/i;

const stats = new Map();
let frames = 0;
let shown = 0;

for (const line of lines) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  const meta = entry?.meta;
  if (!meta || !meta.dir) continue;

  if (sinceTs && entry.ts) {
    const ts = new Date(entry.ts).getTime();
    if (Number.isFinite(ts) && ts < sinceTs) continue;
  }

  const decoded = decodeFrame(meta);
  if (!decoded) continue;
  frames += 1;

  const cmd = String(decoded.cmd || "");
  stats.set(cmd, (stats.get(cmd) || 0) + 1);

  if (statsOnly) continue;

  const matched =
    (cmdFilter ? cmd === cmdFilter : false) ||
    (cmdFilter ? false : showAll || matchedKeyword.test(cmd));
  if (!matched) continue;

  shown += 1;
  const time = entry.ts ? String(entry.ts).slice(11, 19) : "--:--:--";
  const arrow = meta.dir === "out" ? "→" : "←";
  console.log(`\n#${shown} ${time} ${arrow} ${cmd}`);
  if (decoded.seq !== undefined || decoded.code) {
    console.log(
      `   seq=${decoded.seq ?? "-"} ack=${decoded.ack ?? "-"} code=${decoded.code ?? "-"}`,
    );
  }
  console.log(
    stringify(decoded.body)
      .split("\n")
      .map((l) => `   ${l}`)
      .join("\n"),
  );
}

console.log(`\n总帧数: ${frames}，命中输出: ${shown}`);
console.log("\n=== 命令统计 ===");
for (const [cmd, count] of [...stats.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${cmd}`);
}
