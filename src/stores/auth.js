import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useLocalTokenStore } from "./localTokenManager";

/**
 * 登录态（接后端白名单认证）。
 *
 * 登录 token 存 localStorage 的 xyzw_auth_token，请求时用 x-user-token 带给后端。
 * 不复用 Authorization，避免和 API Key 那一层冲突。
 * 原来的本地「假登录」（任意账号都能进）已移除。
 */

const TOKEN_KEY = "xyzw_auth_token";
const USER_KEY = "xyzw_auth_user";

function readUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

export const useAuthStore = defineStore("auth", () => {
  const user = ref(readUser());
  const token = ref(localStorage.getItem(TOKEN_KEY) || null);
  const isLoading = ref(false);

  const localTokenStore = useLocalTokenStore();

  const isAuthenticated = computed(() => Boolean(token.value));
  const isAdmin = computed(() => user.value?.role === "admin");
  const userInfo = computed(() => user.value);

  /** 供所有 /api 请求使用的用户态 header */
  function authHeaders() {
    return token.value ? { "x-user-token": token.value } : {};
  }

  function persist(nextToken, nextUser) {
    token.value = nextToken || null;
    user.value = nextUser || null;
    if (nextToken) localStorage.setItem(TOKEN_KEY, nextToken);
    else localStorage.removeItem(TOKEN_KEY);
    if (nextUser) localStorage.setItem(USER_KEY, JSON.stringify(nextUser));
    else localStorage.removeItem(USER_KEY);
  }

  /**
   * 登录：后端校验白名单与密码。
   * @param {{username: string, password: string}} credentials 账号与密码
   * @returns {Promise<{success: boolean, message?: string}>} 是否成功及失败原因
   */
  const login = async (credentials) => {
    isLoading.value = true;
    try {
      const res = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: String(credentials?.username || "").trim(),
          password: String(credentials?.password || ""),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { success: false, message: data.error || "登录失败" };
      }
      persist(data.token, data.user);
      return { success: true };
    } catch (error) {
      return { success: false, message: error?.message || "网络异常，请检查后端是否启动" };
    } finally {
      isLoading.value = false;
    }
  };

  /** 注册不开放：白名单由管理员在后台添加 */
  const register = async () => ({
    success: false,
    message: "不开放自助注册，请联系管理员开通",
  });

  const logout = async () => {
    const current = token.value;
    if (current) {
      try {
        await fetch("/auth/logout", {
          method: "POST",
          headers: { "x-user-token": current },
        });
      } catch {
        /* 后端不可达也要能登出本地 */
      }
    }
    persist(null, null);
    localStorage.removeItem("gameRoles");
    try {
      localTokenStore.clearUserToken?.();
      localTokenStore.clearAllGameTokens?.();
    } catch {
      /* 清理失败忽略 */
    }
  };

  /** 拉取当前用户信息，顺便验证 token 是否还有效 */
  const fetchUserInfo = async () => {
    if (!token.value) return false;
    try {
      const res = await fetch("/auth/me", { headers: authHeaders() });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) await logout();
        return false;
      }
      const data = await res.json();
      persist(token.value, data.user);
      return true;
    } catch {
      // 网络异常时不直接登出，避免后端暂时不可达把人踢掉
      return false;
    }
  };

  /** 应用启动时恢复登录态 */
  const initAuth = async () => {
    if (!token.value) return;
    await fetchUserInfo();
  };

  return {
    user,
    token,
    isLoading,
    isAuthenticated,
    isAdmin,
    userInfo,
    login,
    register,
    logout,
    fetchUserInfo,
    initAuth,
    authHeaders,
  };
});
