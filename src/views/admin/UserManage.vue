<template>
  <div class="user-manage-view">
    <div class="page-head">
      <div>
        <h2>用户管理</h2>
        <p>白名单控制：只有这里列出的账号才能登录系统</p>
      </div>
      <div class="head-actions">
        <NButton type="primary" @click="openCreate">新增用户</NButton>
        <NButton @click="loadUsers" :loading="loading">刷新</NButton>
      </div>
    </div>

    <n-card title="白名单用户" size="small" class="card-block">
      <n-data-table
        :columns="columns"
        :data="users"
        :loading="loading"
        :bordered="false"
        size="small"
        :row-key="(row) => row.username"
        :pagination="false"
      />
    </n-card>

    <n-card title="登录日志" size="small" class="card-block">
      <div class="log-head">
        <n-select
          v-model:value="logDate"
          :options="logDateOptions"
          placeholder="选择日期"
          style="width: 180px"
          @update:value="loadLogs"
        />
        <NButton size="small" @click="loadLogs" :loading="logLoading">
          刷新日志
        </NButton>
        <span class="log-hint">日志保存在服务器 render-backend/logs/auth-*.log</span>
      </div>

      <n-data-table
        :columns="logColumns"
        :data="logs"
        :loading="logLoading"
        :bordered="false"
        size="small"
        :pagination="{ pageSize: 20 }"
        max-height="420"
      />
    </n-card>

    <!-- 新增 / 编辑用户 -->
    <n-modal
      v-model:show="modalVisible"
      preset="card"
      :title="editing ? `编辑 ${editing.username}` : '新增用户'"
      style="width: 460px"
    >
      <n-form label-placement="top">
        <n-form-item label="用户名">
          <n-input
            v-model:value="form.username"
            :disabled="Boolean(editing)"
            placeholder="字母 / 数字 / 下划线 / 点 / @ / 短横线，2-32 位"
          />
        </n-form-item>
        <n-form-item :label="editing ? '重置密码（留空不改）' : '密码'">
          <n-input
            v-model:value="form.password"
            type="password"
            show-password-on="click"
            placeholder="至少 6 位"
          />
        </n-form-item>
        <n-form-item label="角色">
          <n-radio-group v-model:value="form.role">
            <n-space>
              <n-radio value="user">普通用户</n-radio>
              <n-radio value="admin">管理员</n-radio>
            </n-space>
          </n-radio-group>
        </n-form-item>
        <n-form-item label="备注">
          <n-input v-model:value="form.note" placeholder="例如：同事张三" />
        </n-form-item>
      </n-form>
      <template #footer>
        <div class="modal-footer">
          <NButton @click="modalVisible = false">取消</NButton>
          <NButton type="primary" :loading="saving" @click="onSave">
            保存
          </NButton>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup>
import { NButton, NTag, useDialog, useMessage } from "naive-ui";
import { computed, h, onMounted, reactive, ref } from "vue";
import { useAuthStore } from "@/stores/auth";

const authStore = useAuthStore();
const message = useMessage();
const dialog = useDialog();

const users = ref([]);
const loading = ref(false);
const saving = ref(false);
const modalVisible = ref(false);
const editing = ref(null);

const form = reactive({
  username: "",
  password: "",
  role: "user",
  note: "",
});

const logs = ref([]);
const logLoading = ref(false);
const logDate = ref("");
const logDates = ref([]);

const logDateOptions = computed(() =>
  logDates.value.map((d) => ({ label: d, value: d })),
);

const columns = [
  { title: "用户名", key: "username", width: 160 },
  {
    title: "角色",
    key: "role",
    width: 100,
    render: (row) =>
      h(
        NTag,
        { size: "small", type: row.role === "admin" ? "warning" : "default" },
        { default: () => (row.role === "admin" ? "管理员" : "普通") },
      ),
  },
  {
    title: "状态",
    key: "enabled",
    width: 90,
    render: (row) =>
      h(
        NTag,
        { size: "small", type: row.enabled ? "success" : "error" },
        { default: () => (row.enabled ? "启用" : "停用") },
      ),
  },
  { title: "备注", key: "note", ellipsis: { tooltip: true } },
  {
    title: "最后登录",
    key: "lastLoginAt",
    width: 180,
    render: (row) =>
      row.lastLoginAt ? formatTime(row.lastLoginAt) : h("span", { style: "color:#9ca3af" }, "从未登录"),
  },
  {
    title: "IP",
    key: "lastLoginIp",
    width: 150,
    render: (row) => row.lastLoginIp || "-",
  },
  {
    title: "操作",
    key: "actions",
    width: 210,
    render: (row) =>
      h("div", { style: "display:flex;gap:8px" }, [
        h(
          NButton,
          { size: "tiny", onClick: () => toggleEnabled(row) },
          { default: () => (row.enabled ? "停用" : "启用") },
        ),
        h(
          NButton,
          { size: "tiny", onClick: () => openEdit(row) },
          { default: () => "改密" },
        ),
        h(
          NButton,
          { size: "tiny", type: "error", onClick: () => removeUser(row) },
          { default: () => "删除" },
        ),
      ]),
  },
];

const logColumns = [
  {
    title: "时间",
    key: "ts",
    width: 170,
    render: (row) => formatTime(row.ts),
  },
  {
    title: "动作",
    key: "action",
    width: 110,
    render: (row) => actionLabel(row.action),
  },
  { title: "用户名", key: "username", width: 140 },
  {
    title: "结果",
    key: "ok",
    width: 80,
    render: (row) =>
      h(
        NTag,
        { size: "small", type: row.ok ? "success" : "error" },
        { default: () => (row.ok ? "成功" : "失败") },
      ),
  },
  { title: "说明", key: "reason", ellipsis: { tooltip: true } },
  { title: "IP", key: "ip", width: 150 },
];

function formatTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function actionLabel(action) {
  const map = {
    login: "登录",
    login_fail: "登录失败",
    logout: "登出",
    user_create: "新增用户",
    user_update: "修改用户",
    user_delete: "删除用户",
  };
  return map[action] || action || "-";
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authStore.authHeaders(),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function loadUsers() {
  loading.value = true;
  try {
    const data = await api("/auth/users");
    users.value = data.users || [];
  } catch (error) {
    message.error(error.message);
  } finally {
    loading.value = false;
  }
}

async function loadLogs() {
  logLoading.value = true;
  try {
    const query = logDate.value ? `?date=${encodeURIComponent(logDate.value)}` : "";
    const data = await api(`/auth/logs${query}`);
    logs.value = data.logs || [];
    logDates.value = data.dates || [];
    if (!logDate.value && logDates.value.length) logDate.value = logDates.value[0];
  } catch (error) {
    message.error(error.message);
  } finally {
    logLoading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  Object.assign(form, { username: "", password: "", role: "user", note: "" });
  modalVisible.value = true;
}

function openEdit(row) {
  editing.value = row;
  Object.assign(form, {
    username: row.username,
    password: "",
    role: row.role,
    note: row.note || "",
  });
  modalVisible.value = true;
}

async function onSave() {
  if (saving.value) return;
  if (!editing.value && !form.username.trim()) {
    message.warning("请填写用户名");
    return;
  }
  if (!editing.value && form.password.length < 6) {
    message.warning("密码至少 6 位");
    return;
  }
  if (editing.value && form.password && form.password.length < 6) {
    message.warning("密码至少 6 位");
    return;
  }

  saving.value = true;
  try {
    if (editing.value) {
      const patch = { role: form.role, note: form.note };
      if (form.password) patch.password = form.password;
      await api(`/auth/users/${encodeURIComponent(editing.value.username)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      message.success("已更新");
    } else {
      await api("/auth/users", {
        method: "POST",
        body: JSON.stringify({
          username: form.username.trim(),
          password: form.password,
          role: form.role,
          note: form.note,
        }),
      });
      message.success("已新增");
    }
    modalVisible.value = false;
    await loadUsers();
  } catch (error) {
    message.error(error.message);
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(row) {
  try {
    await api(`/auth/users/${encodeURIComponent(row.username)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !row.enabled }),
    });
    message.success(row.enabled ? "已停用" : "已启用");
    await loadUsers();
  } catch (error) {
    message.error(error.message);
  }
}

function removeUser(row) {
  dialog.warning({
    title: "删除用户",
    content: `确认删除「${row.username}」？删除后该账号将无法登录。`,
    positiveText: "删除",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        await api(`/auth/users/${encodeURIComponent(row.username)}`, {
          method: "DELETE",
        });
        message.success("已删除");
        await loadUsers();
      } catch (error) {
        message.error(error.message);
      }
    },
  });
}

onMounted(async () => {
  await Promise.all([loadUsers(), loadLogs()]);
});
</script>

<style scoped>
.user-manage-view {
  padding: 20px;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
}

.page-head h2 {
  margin: 0;
  font-size: 20px;
  color: #1f2937;
}

.page-head p {
  margin: 6px 0 0;
  font-size: 13px;
  color: #6b7280;
}

.head-actions {
  display: flex;
  gap: 8px;
}

.card-block {
  margin-bottom: 16px;
}

.log-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.log-hint {
  font-size: 12px;
  color: #9ca3af;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
