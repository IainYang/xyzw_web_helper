<template>
  <div class="sync-code-form">
    <p class="tip">
      在另一台设备（电脑端）打开 Token 管理 → 勾选账号 → 点「同步码」，把生成的
      32 位码填到这里。同步码 <strong>10 分钟</strong>内有效，且只能导入一次；
      账号的 BIN 会一起同步，导入后可以直接刷新。
    </p>

    <n-input
      v-model:value="code"
      placeholder="粘贴 32 位同步码"
      :maxlength="40"
      clearable
      size="large"
      @update:value="onInput"
    />

    <n-button
      type="primary"
      block
      ghost
      size="large"
      style="margin-top: 12px"
      :loading="peeking"
      :disabled="clean.length !== 32"
      @click="onPeek"
    >
      校验同步码
    </n-button>

    <div v-if="preview" class="preview-box">
      <div class="preview-title">
        共 {{ preview.count }} 个账号 · 剩余 {{ leftText }}
      </div>
      <div class="preview-names">{{ preview.names.join("、") }}</div>
      <n-button
        type="primary"
        block
        size="large"
        style="margin-top: 12px"
        :loading="importing"
        @click="onImport"
      >
        导入到本机
      </n-button>
    </div>

    <p class="tip small">
      导入时会按 token 去重，已存在的账号不会重复添加。
    </p>

    <n-button block size="large" @click="$emit('cancel')">取消</n-button>
  </div>
</template>

<script setup>
import { useMessage } from "naive-ui";
import { computed, onUnmounted, ref } from "vue";
import { useTokenStore } from "@/stores/tokenStore";
import { restoreTokenBins, stripTokenBins } from "@/utils/tokenBinBackup";
import { peekSyncCode, redeemSyncCode } from "@/utils/tokenSyncApi";

const $emit = defineEmits(["cancel", "ok"]);

const message = useMessage();
const tokenStore = useTokenStore();

const code = ref("");
const peeking = ref(false);
const importing = ref(false);
const preview = ref(null);
const expireAt = ref(0);
const now = ref(Date.now());

let timer = null;
function startTimer() {
  if (timer) return;
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
}
onUnmounted(() => {
  if (timer) clearInterval(timer);
});

const clean = computed(() =>
  String(code.value || "")
    .replace(/[\s-]/g, "")
    .toUpperCase(),
);

const leftText = computed(() => {
  const ms = Math.max(0, expireAt.value - now.value);
  if (ms <= 0) return "已过期";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
});

function onInput(v) {
  const normalized = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized !== v) code.value = normalized.slice(0, 32);
  preview.value = null;
}

async function onPeek() {
  if (clean.value.length !== 32) return;
  peeking.value = true;
  preview.value = null;
  try {
    const res = await peekSyncCode(clean.value);
    preview.value = res;
    expireAt.value = new Date(res.expiresAt).getTime();
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
    const { tokens } = await redeemSyncCode(clean.value);
    // 先把同步带来的 BIN 写回本机 IndexedDB（刷新 token 依赖它），再入库列表
    const binStat = await restoreTokenBins(tokens);
    const incoming = stripTokenBins(tokens);
    const existing = new Set((tokenStore.gameTokens || []).map((t) => t.token));
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
    if (added) {
      message.success(
        skipped
          ? `已导入 ${added} 个账号，跳过 ${skipped} 个已存在`
          : `已导入 ${added} 个账号`,
      );
    } else {
      message.info(`这 ${skipped} 个账号本机都已存在`);
    }
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
    $emit("ok");
  } catch (error) {
    message.error(error.message || "导入失败");
  } finally {
    importing.value = false;
  }
}
</script>

<style scoped lang="scss">
.sync-code-form {
  padding-top: 4px;
}

.tip {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);

  &.small {
    margin-top: 12px;
    margin-bottom: 12px;
    font-size: 12px;
    color: var(--text-tertiary);
  }
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
