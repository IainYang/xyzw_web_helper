import { openDB } from "idb";

/**
 * Token 的 BIN 数据随配置文件走。
 *
 * 背景：「长期有效」账号点「刷新」时需要重新生成登录 bin。原始 bin 存在
 * IndexedDB（库 `xyzw` / 表 `tokens`，键为 token.id）。但从「导出配置」拿到
 * 的 JSON 里只有 token 字符串，换设备导入后 IndexedDB 是空的，刷新必然失败。
 *
 * 这里做两件事：
 * - 导出前 attachTokenBins()：把 IndexedDB 里的 bin 以 base64 挂在 token 上
 * - 导入后 restoreTokenBins()：把 base64 写回 IndexedDB，之后刷新就能用
 */

const DB_NAME = "xyzw";
const STORE = "tokens";

/** ArrayBuffer → base64 */
function bufToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → ArrayBuffer */
export function base64ToBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function openTokensDB() {
  try {
    return await openDB(DB_NAME);
  } catch {
    return null;
  }
}

/**
 * 给 token 列表挂上 IndexedDB 里的 bin（base64）。
 * 取不到的账号不带 bin 字段，不影响导出。
 * @param {Array<object>} tokens token 列表
 * @returns {Promise<Array<object>>} 带 bin 字段的新列表
 */
export async function attachTokenBins(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  const db = await openTokensDB();
  if (!db) return list;
  try {
    const out = [];
    for (const t of list) {
      const item =
        (t?.id ? await db.get(STORE, t.id) : null) ||
        (t?.name ? await db.get(STORE, t.name) : null);
      if (item?.data) {
        out.push({ ...t, bin: bufToBase64(item.data) });
      } else {
        out.push({ ...t });
      }
    }
    return out;
  } catch {
    return list;
  } finally {
    db.close?.();
  }
}

/**
 * 把 token 列表里携带的 bin 写回 IndexedDB（键统一用 token.id）。
 * @param {Array<object>} tokens 带 bin 字段的 token 列表
 * @returns {Promise<{restored: number, failed: number}>} 写入统计
 */
export async function restoreTokenBins(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  const withBin = list.filter((t) => t?.bin && t?.id);
  if (!withBin.length) return { restored: 0, failed: 0 };

  const db = await openTokensDB();
  if (!db) return { restored: 0, failed: withBin.length };

  let restored = 0;
  let failed = 0;
  try {
    for (const t of withBin) {
      try {
        const buf = base64ToBuffer(t.bin);
        await db.put(STORE, {
          id: t.id,
          data: buf,
          metadata: { name: t.name, server: t.server, restoredAt: Date.now() },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        restored += 1;
      } catch {
        failed += 1;
      }
    }
  } finally {
    db.close?.();
  }
  return { restored, failed };
}

/**
 * 去掉 token 上的 bin 字段（避免把 base64 存进 localStorage）。
 * @param {Array<object>} tokens token 列表
 * @returns {Array<object>} 不含 bin 的新列表
 */
export function stripTokenBins(tokens) {
  return (Array.isArray(tokens) ? tokens : []).map((t) => {
    if (!t || !Object.hasOwn(t, "bin")) return t;
    const copy = { ...t };
    delete copy.bin;
    return copy;
  });
}
