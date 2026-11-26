/**
 * 跨端同步码接口封装。
 *
 * 走 /api/sync/*：
 * - 生成：POST /api/sync/create  { tokens }  → { code, expiresAt, count }
 * - 预览：GET  /api/sync/info?code=xxx        → { count, expiresAt, names }
 * - 兑换：POST /api/sync/redeem { code }      → { tokens }
 *
 * 登录 token 由 main.js 的 fetch 包装统一注入（x-user-token），这里不用管。
 */

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
  }
  return data || {};
}

/**
 * 生成同步码。
 * @param {Array<object>} tokens 要同步的账号
 * @returns {Promise<{code: string, expiresAt: string, count: number}>} 同步码、到期时间、账号数
 */
export function createSyncCode(tokens) {
  return request("/api/sync/create", {
    method: "POST",
    body: JSON.stringify({ tokens }),
  });
}

/**
 * 预览同步码（不消费）。
 * @param {string} code 32 位同步码
 * @returns {Promise<{count: number, expiresAt: string, names: string[]}>} 账号数、到期时间、账号名
 */
export function peekSyncCode(code) {
  return request(`/api/sync/info?code=${encodeURIComponent(code)}`);
}

/**
 * 兑换同步码（一次性，成功后码立即失效）。
 * @param {string} code 32 位同步码
 * @returns {Promise<{tokens: Array<object>}>} 同步过来的账号
 */
export function redeemSyncCode(code) {
  return request("/api/sync/redeem", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}
