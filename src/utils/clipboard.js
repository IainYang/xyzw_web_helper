/**
 * 剪贴板写入（含 http 非安全上下文的兜底）。
 *
 * 背景：线上是 `http://<ip>`，属于非安全上下文，`navigator.clipboard` 根本不存在，
 * 只能走 `document.execCommand("copy")`。而 naive-ui 的弹窗带 focus trap：
 * 把临时 textarea 塞到 `document.body` 会被立刻抢回焦点、选区清空，
 * `execCommand` 依旧返回 true —— 于是出现「提示复制成功、剪贴板却是空的」。
 *
 * 所以这里的策略是（按顺序尝试）：
 * 1. 安全上下文优先用异步剪贴板 API；
 * 2. 选中调用方给的「弹窗内可见文本」再 execCommand（选区在弹窗内，不会被抢焦点）；
 * 3. 退到「放进弹窗容器里的透明 textarea」，并校验焦点与选区是否真的生效；
 * 4. 全失败返回 false —— 调用方必须提示手动复制，**不要谎报成功**。
 */

/** 是否可用异步剪贴板 API（https / localhost 才有） */
export function canUseAsyncClipboard() {
  return Boolean(window.isSecureContext && navigator.clipboard?.writeText);
}

/**
 * 选中元素内的全部文本。
 * @param {HTMLElement|null} el 目标元素
 * @returns {boolean} 是否选中了非空文本
 */
export function selectElementText(el) {
  if (!el || el.nodeType !== 1) return false;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.toString().length > 0;
  } catch {
    return false;
  }
}

function execCopy() {
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

/** 找离 anchor 最近的弹窗容器（naive / arco 都覆盖） */
function findDialogHost(anchor) {
  const el = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
  return (
    el?.closest?.(
      '[role="dialog"], .n-modal, .n-modal-container, .n-dialog, .arco-modal',
    ) || null
  );
}

/**
 * 用临时 textarea 复制。container 必须是「焦点陷阱认可的范围」，
 * 否则 focus 会被弹窗抢走，复制静默失败。
 * @param {string} text 文本
 * @param {HTMLElement} container 挂载容器
 * @returns {boolean} 浏览器是否接受了这次复制
 */
function copyViaTextarea(text, container) {
  if (!container) return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  // 绝对定位到容器外侧，但仍在容器 DOM 内：既不可见，又不会被 focus trap 抢焦点
  ta.style.cssText =
    "position:absolute;left:-9999px;top:0;width:1px;height:1px;padding:0;border:0;margin:0;opacity:0;font-size:12pt;";
  container.appendChild(ta);
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    const focused = document.activeElement === ta;
    const ranged =
      ta.selectionStart === 0 && ta.selectionEnd === text.length;
    if (!focused || !ranged) return false;
    return execCopy();
  } finally {
    container.removeChild(ta);
  }
}

/**
 * 复制文本到剪贴板。
 * @param {string} text 要复制的文本
 * @param {{anchor?: Element, selectEl?: HTMLElement, preferAsync?: boolean}} [options]
 *   anchor：触发复制的按钮（用来找所在弹窗）；selectEl：弹窗里已展示的文本节点
 * @returns {Promise<boolean>} true = 浏览器认可成功；false = 需要引导用户手动复制
 */
export async function copyText(text, options = {}) {
  const value = String(text ?? "");
  if (!value) return false;

  const { anchor, selectEl, preferAsync = true } = options;

  // 1. 异步剪贴板 API（仅安全上下文；失败继续兜底）
  if (preferAsync && canUseAsyncClipboard()) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      /* 权限被拒 / 非用户手势，继续兜底 */
    }
  }

  // 2. 直接选中弹窗里已经展示出来的文本再复制
  if (selectEl && selectElementText(selectEl) && execCopy()) return true;

  // 3. 弹窗容器内塞透明 textarea；4. 再退回 body（非弹窗场景）
  const host = findDialogHost(anchor);
  if (copyViaTextarea(value, host)) return true;
  if (host && copyViaTextarea(value, document.body)) return true;
  if (!host) return copyViaTextarea(value, document.body);
  return false;
}
