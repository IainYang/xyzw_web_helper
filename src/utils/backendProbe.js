/**
 * 探测当前这套部署有没有后端（`/auth/*` 是否可用）。
 *
 * 场景：前端 dist 可能被单独丢到静态托管（GitHub Pages / OSS / 只放静态文件的
 * nginx）。这时账户体系本身不成立——白名单、token 签发、日志统统没有，
 * 登录页会永远登不进去。前端启动时探一次：
 * - 命中 JSON（`/auth/probe` 正常返回，或 `/auth/me` 返回 401 JSON）→ 后端在，正常登录
 * - 拿到 HTML（SPA 回退的 index.html）、404 静态响应或连接失败 → 没有后端，跳过登录
 *
 * 结果只在当前页面生命周期内缓存；刷新会重新探测，避免「后端补上了但页面还认为没有」。
 */

const PROBE_URL = "/auth/probe";
const FALLBACK_URL = "/auth/me";
const TIMEOUT_MS = 6000;

let cached = null;
let inflight = null;

/**
 * 发一次 JSON 探测请求。
 * @param {string} url 探测地址
 * @returns {Promise<{json: boolean, status: number, data: any}>} 是否 JSON 响应、状态码、解析后的 body
 */
async function probeJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const type = res.headers.get("content-type") || "";
    if (!type.includes("application/json")) {
      // 静态托管：不存在的路径被回退成 index.html
      return { json: false, status: res.status, data: null };
    }
    const data = await res.json().catch(() => null);
    return { json: true, status: res.status, data };
  } catch {
    // 超时 / 断网 / CORS
    return { json: false, status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

async function doProbe() {
  const primary = await probeJson(PROBE_URL);
  if (primary.json) {
    return {
      available: true,
      // 老后端没有 /auth/probe（404 JSON）时按「需要登录」处理，行为与以前一致
      requireLogin: primary.data?.requireLogin !== false,
      reason: "",
    };
  }

  // 兜底：老版本后端没有 /auth/probe，用 /auth/me 判断（未登录时是 401 JSON）
  const fallback = await probeJson(FALLBACK_URL);
  if (fallback.json) {
    return { available: true, requireLogin: true, reason: "" };
  }

  return {
    available: false,
    requireLogin: false,
    reason: primary.status
      ? `未检测到后端接口（HTTP ${primary.status}）`
      : "未检测到后端接口（请求失败）",
  };
}

/**
 * 探测后端可用性（带并发去重与结果缓存）。
 * @param {{force?: boolean}} [options] force=true 时忽略缓存重新探测
 * @returns {Promise<{available: boolean, requireLogin: boolean, reason: string}>} 探测结果：是否有后端、是否需要登录、以及不可用时的一句说明
 */
export function detectBackend(options = {}) {
  if (options.force) {
    cached = null;
    inflight = null;
  }
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = doProbe()
    .then((result) => {
      cached = result;
      return result;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 同步读取上次探测结果（还没探过时为 null） */
export function getBackendProbe() {
  return cached;
}
