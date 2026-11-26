<template>
  <n-modal
    v-model:show="visible"
    preset="card"
    title="跨端同步 Token"
    class="sync-code-modal"
    :style="{ width: 'min(520px, 92vw)' }"
    :bordered="false"
  >
    <n-tabs v-model:value="tab" type="segment" size="small" animated>
      <!-- ============ 生成 ============ -->
      <n-tab-pane name="create" tab="生成同步码">
        <div v-if="!code" class="section">
          <p class="hint">
            将把<strong>当前勾选的 {{ selectedTokens.length }} 个账号</strong>
            打包成一个 32 位同步码，在另一台设备输入即可导入。
          </p>
          <n-alert v-if="!selectedTokens.length" type="warning" :bordered="false">
            还没有勾选账号。请先关闭本窗口，在列表里勾选要同步的账号。
          </n-alert>
          <n-alert v-else type="info" :bordered="false">
            同步码 <strong>10 分钟</strong>内有效，且<strong>只能导入一次</strong>，
            兑换后服务器上立即删除。账号的 BIN 会一起打包，新设备上可直接刷新。
          </n-alert>
          <div class="token-preview">
            <div
              v-for="t in selectedTokens.slice(0, 6)"
              :key="t.id"
              class="preview-item"
            >
              {{ t.name }}
            </div>
            <div v-if="selectedTokens.length > 6" class="preview-more">
              等 {{ selectedTokens.length }} 个
            </div>
          </div>
          <n-button
            type="primary"
            block
            :loading="creating"
            :disabled="!selectedTokens.length"
            @click="onCreate"
          >
            生成同步码
          </n-button>
        </div>

        <div v-else class="section">
          <div class="code-box">
            <div ref="codeTextRef" class="code-text">{{ formattedCode }}</div>
            <div class="code-meta">
              剩余 <strong>{{ countdownText }}</strong> · 可导入
              {{ codeCount }} 个账号
            </div>
          </div>
          <n-space :size="8" style="margin-top: 12px">
            <n-button
              type="primary"
              ghost
              :disabled="leftMs <= 0"
              @click="(e) => copyCode(e)"
            >
              <template #icon>
                <n-icon><Copy /></n-icon>
              </template>
              复制同步码
            </n-button>
            <n-button quaternary @click="resetCreate">重新生成</n-button>
          </n-space>
          <p class="hint small">
            在手机端打开「Token 管理 → 添加Token → 同步码导入」，输入这串码即可；
            手机长按上面的码可直接选中复制。
          </p>
        </div>
      </n-tab-pane>

      <!-- ============ 导入 ============ -->
      <n-tab-pane name="import" tab="用同步码导入">
        <div class="section">
          <n-input
            v-model:value="inputCode"
            placeholder="粘贴 32 位同步码"
            :maxlength="40"
            clearable
            @update:value="onCodeInput"
          />
          <n-button
            type="primary"
            block
            ghost
            style="margin-top: 10px"
            :loading="peeking"
            :disabled="cleanInput.length !== 32"
            @click="onPeek"
          >
            校验同步码
          </n-button>

          <div v-if="preview" class="preview-box">
            <div class="preview-title">
              共 {{ preview.count }} 个账号 · 剩余 {{ countdownText }}
            </div>
            <div class="preview-names">{{ preview.names.join("、") }}</div>
            <n-button
              type="primary"
              block
              style="margin-top: 12px"
              :loading="importing"
              @click="onImport"
            >
              导入到本机
            </n-button>
          </div>

          <p class="hint small">
            导入时会按 token 去重，已存在的账号不会重复添加。
          </p>
        </div>
      </n-tab-pane>
    </n-tabs>
  </n-modal>
</template>

<script setup>
import { Copy } from "@vicons/ionicons5";
import { useMessage } from "naive-ui";
import { computed, onUnmounted, ref, watch } from "vue";
import { useTokenStore } from "@/stores/tokenStore";
import { copyText, selectElementText } from "@/utils/clipboard";
import {
  attachTokenBins,
  restoreTokenBins,
  stripTokenBins,
} from "@/utils/tokenBinBackup";
import {
  createSyncCode,
  peekSyncCode,
  redeemSyncCode,
} from "@/utils/tokenSyncApi";

const props = defineProps({
  show: { type: Boolean, default: false },
  /** 当前勾选的账号（只同步这些） */
  selectedTokens: { type: Array, default: () => [] },
  /** 打开时默认停在哪个页签：create / import */
  initialTab: { type: String, default: "create" },
});
const emit = defineEmits(["update:show", "imported"]);

const message = useMessage();
const tokenStore = useTokenStore();

const visible = computed({
  get: () => props.show,
  set: (v) => emit("update:show", v),
});

const tab = ref("create");

// ---------- 生成 ----------
const creating = ref(false);
const code = ref("");
const codeCount = ref(0);
const expireAt = ref(0);
/** 展示同步码的节点：复制时优先选中它（在弹窗内，不会被 focus trap 清掉选区） */
const codeTextRef = ref(null);

// ---------- 导入 ----------
const inputCode = ref("");
const peeking = ref(false);
const importing = ref(false);
const preview = ref(null);
const previewExpireAt = ref(0);

// ---------- 倒计时 ----------
const now = ref(Date.now());
let timer = null;
function startTimer() {
  if (timer) return;
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
}
function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

const leftMs = computed(() => Math.max(0, expireAt.value - now.value));
const previewLeftMs = computed(() =>
  Math.max(0, previewExpireAt.value - now.value),
);

function fmtLeft(ms) {
  if (ms <= 0) return "已过期";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
const countdownText = computed(() => {
  const target =
    tab.value === "import" && preview.value ? previewLeftMs.value : leftMs.value;
  return fmtLeft(target);
});

const formattedCode = computed(() =>
  (code.value || "").replace(/(.{8})(?=.)/g, "$1 "),
);

const cleanInput = computed(() =>
  String(inputCode.value || "")
    .replace(/[\s-]/g, "")
    .toUpperCase(),
);

function onCodeInput(v) {
  // 边输边归一化：去空格、转大写，方便从聊天里粘贴
  const normalized = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized !== v) inputCode.value = normalized.slice(0, 32);
  preview.value = null;
}

async function onCreate() {
  if (!props.selectedTokens.length) return;
  creating.value = true;
  try {
    // 把 IndexedDB 里的 BIN 一起打包，否则新设备刷新 token 会报「缺少本地 BIN」
    const withBins = await attachTokenBins(props.selectedTokens);
    const res = await createSyncCode(withBins);
    code.value = res.code;
    codeCount.value = res.count;
    expireAt.value = new Date(res.expiresAt).getTime();
    startTimer();
  } catch (error) {
    message.error(error.message || "生成失败");
  } finally {
    creating.value = false;
  }
}

/**
 * 复制同步码。
 * 线上是 http 源，navigator.clipboard 不存在；而弹窗的 focus trap 会让
 * 「塞到 body 的临时 textarea」复制静默失败（execCommand 仍返回 true）。
 * 这里优先选中弹窗里可见的码再复制，失败就明确提示手动复制。
 * @param {MouseEvent} [evt] 点击事件，用于定位所在弹窗
 */
async function copyCode(evt) {
  const text = code.value;
  if (!text) return;
  const ok = await copyText(text, {
    selectEl: codeTextRef.value,
    anchor: evt?.currentTarget || codeTextRef.value,
  });
  if (ok) {
    message.success("同步码已复制");
    return;
  }
  // 兜底：至少帮用户把码选中并说明怎么手动复制，不再谎报成功
  selectElementText(codeTextRef.value);
  message.warning(
    "浏览器阻止了自动复制，已帮你选中同步码，按 Ctrl+C（手机长按）复制即可",
  );
}

function resetCreate() {
  code.value = "";
  codeCount.value = 0;
  expireAt.value = 0;
}

async function onPeek() {
  if (cleanInput.value.length !== 32) return;
  peeking.value = true;
  preview.value = null;
  try {
    const res = await peekSyncCode(cleanInput.value);
    preview.value = res;
    previewExpireAt.value = new Date(res.expiresAt).getTime();
    startTimer();
  } catch (error) {
    message.error(error.message || "校验失败");
  } finally {
    peeking.value = false;
  }
}

async function onImport() {
  if (!preview.value) return;
  importing.value = true;
  try {
    const { tokens } = await redeemSyncCode(cleanInput.value);
    // 先把带来的 BIN 写回本机 IndexedDB（刷新 token 依赖它），再入库列表
    const binStat = await restoreTokenBins(tokens);
    const incoming = stripTokenBins(tokens);
    const existing = new Set(
      (tokenStore.gameTokens || []).map((t) => t.token),
    );
    let added = 0;
    let skipped = 0;
    for (const t of incoming) {
      if (!t?.token || existing.has(t.token)) {
        skipped += 1;
        continue;
      }
      tokenStore.addToken(t);
      existing.add(t.token);
      added += 1;
    }
    emit("imported", { added, skipped, bins: binStat.restored });
    if (added) {
      message.success(
        skipped
          ? `已导入 ${added} 个账号，跳过 ${skipped} 个已存在`
          : `已导入 ${added} 个账号`,
      );
    } else {
      message.info(`这 ${skipped} 个账号本机都已存在`);
    }
    // 源端 IndexedDB 里就没 BIN 的账号，同步过来自然也刷不了，提前告知
    if (
      binStat.restored === 0 &&
      incoming.some((t) =>
        ["wxQrcode", "bin", "mobile"].includes(t.importMethod),
      )
    ) {
      message.warning(
        "同步数据里没有 BIN，这些账号暂不能「刷新」，需要重新扫码或导入 BIN",
      );
    }
    resetImport();
    visible.value = false;
  } catch (error) {
    message.error(error.message || "导入失败");
  } finally {
    importing.value = false;
  }
}

function resetImport() {
  inputCode.value = "";
  preview.value = null;
  previewExpireAt.value = 0;
}

// 打开时按调用方指定的页签进入；关闭时清理倒计时与一次性状态
watch(visible, (v) => {
  if (v) {
    tab.value = props.initialTab === "import" ? "import" : "create";
  } else {
    stopTimer();
    resetCreate();
    resetImport();
  }
});

onUnmounted(stopTimer);
</script>

<style scoped lang="scss">
.sync-code-modal {
  :deep(.n-card__content) {
    padding-top: 8px;
  }
}

.section {
  padding-top: 4px;
}

.hint {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);

  &.small {
    margin-top: 12px;
    margin-bottom: 0;
    font-size: 12px;
    color: var(--text-tertiary);
  }
}

.token-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0;
}

.preview-item {
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--bg-tertiary, #f3f4f6);
  font-size: 12px;
  color: var(--text-secondary);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-more {
  padding: 3px 8px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.code-box {
  padding: 16px;
  border-radius: 12px;
  background: var(--bg-secondary, #f9fafb);
  border: 1px dashed var(--border-color, #d1d5db);
  text-align: center;
}

.code-text {
  font-family: "SF Mono", "Monaco", "Consolas", monospace;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 1px;
  word-break: break-all;
  color: var(--text-primary, #111827);
  user-select: all;
}

.code-meta {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.preview-box {
  margin-top: 14px;
  padding: 12px;
  border-radius: 10px;
  background: var(--bg-secondary, #f9fafb);
}

.preview-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.preview-names {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  word-break: break-all;
}
</style>
