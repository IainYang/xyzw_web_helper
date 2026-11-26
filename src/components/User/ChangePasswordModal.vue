<template>
  <n-modal
    v-model:show="visible"
    preset="card"
    title="修改密码"
    class="change-password-modal"
    :style="{ width: 'min(460px, 92vw)' }"
    :bordered="false"
  >
    <n-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-placement="top"
      size="medium"
      @submit.prevent="onSubmit"
    >
      <n-form-item label="当前密码" path="oldPassword">
        <n-input
          v-model:value="form.oldPassword"
          type="password"
          show-password-on="click"
          placeholder="请输入当前密码"
        />
      </n-form-item>
      <n-form-item label="新密码" path="newPassword">
        <n-input
          v-model:value="form.newPassword"
          type="password"
          show-password-on="click"
          placeholder="至少 8 位"
        />
      </n-form-item>
      <n-form-item label="确认新密码" path="confirmPassword">
        <n-input
          v-model:value="form.confirmPassword"
          type="password"
          show-password-on="click"
          placeholder="请再次输入新密码"
          @keyup.enter="onSubmit"
        />
      </n-form-item>

      <n-alert type="info" :bordered="false" style="margin-bottom: 12px">
        修改成功后需要用新密码重新登录，其他设备上的登录状态也会失效。
      </n-alert>

      <div class="modal-actions">
        <n-button @click="visible = false">取消</n-button>
        <n-button type="primary" :loading="submitting" attr-type="submit">
          确认修改
        </n-button>
      </div>
    </n-form>
  </n-modal>
</template>

<script setup>
import { useMessage } from "naive-ui";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const props = defineProps({
  show: { type: Boolean, default: false },
});
const emit = defineEmits(["update:show"]);

const message = useMessage();
const router = useRouter();
const authStore = useAuthStore();

const visible = computed({
  get: () => props.show,
  set: (v) => emit("update:show", v),
});

const formRef = ref(null);
const submitting = ref(false);
const form = ref({ oldPassword: "", newPassword: "", confirmPassword: "" });

const rules = {
  oldPassword: [{ required: true, message: "请输入当前密码", trigger: ["blur"] }],
  newPassword: [
    { required: true, message: "请输入新密码", trigger: ["blur"] },
    {
      validator: (_, value) =>
        !value || value.length >= 8 ? true : new Error("新密码至少 8 位"),
      trigger: ["blur", "input"],
    },
    {
      validator: (_, value) =>
        value !== form.value.oldPassword
          ? true
          : new Error("新密码不能与当前密码相同"),
      trigger: ["blur"],
    },
  ],
  confirmPassword: [
    { required: true, message: "请再次输入新密码", trigger: ["blur"] },
    {
      validator: (_, value) =>
        value === form.value.newPassword ? true : new Error("两次输入的密码不一致"),
      trigger: ["blur", "input"],
    },
  ],
};

function reset() {
  form.value = { oldPassword: "", newPassword: "", confirmPassword: "" };
  formRef.value?.restoreValidation();
}

async function onSubmit() {
  if (submitting.value) return;
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  submitting.value = true;
  try {
    const res = await authStore.changePassword(
      form.value.oldPassword,
      form.value.newPassword,
    );
    if (!res.success) {
      message.error(res.message || "修改失败");
      return;
    }
    message.success("密码已修改，请用新密码重新登录");
    visible.value = false;
    await authStore.logout();
    router.replace("/login");
  } finally {
    submitting.value = false;
  }
}

watch(visible, (v) => {
  if (!v) reset();
});
</script>

<style scoped lang="scss">
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
