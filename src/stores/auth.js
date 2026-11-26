import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { detectBackend } from "@/utils/backendProbe";
import { useLocalTokenStore } from "./localTokenManager";

/**
 * 登录态（接后端白名单认证）。
 *
 * 登录 token 存 localStorage 的 xyzw_auth_token，请求时用 x-user-token 带给后端。
 * 不复用 Authorization，避免和 API Key 那一层冲突。
 * 原来的本地「假登录」（任意账号都能进）已移除。
 *
 * 例外：如果这套部署**根本没有后端**（dist 被单独丢到静态站），账户体系不成立，
 * 启动时探测到 `/auth/*` 不存在就直接跳过登录流程（authDisabled = true），
 * 页面照常可用，只是没有白名单、日志与后台推关。
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

  /** 后端是否可用（启动时探测 /auth/*） */
  const backendAvailable = ref(true);
  /** 没有后端 → 账户体系不成立，跳过登录流程 */
  const authDisabled = ref(false);
  /** 探测原因，便于在页面上给一句解释 */
  const probeReason = ref("");
  /** 探测是否已完成，避免路由守卫反复等待 */
  const probeDone = ref(false);
  let probePromise = null;

  const localTokenStore = useLocalTokenStore();

  const isAuthenticated = computed(
    () => Boolean(token.value) || authDisabled.value,
  );
  const isAdmin = computed(() => user.value?.role === "admin");
  const userInfo = computed(() => user.value);

  /**
   * 探测后端可用性（只探一次，多处调用会复用同一个 Promise）。
   * 两种情况都跳过登录：
   * - 没有后端（静态托管，账户体系不成立）；
   * - 后端显式关闭了登录校验（REQUIRE_LOGIN=0，本地调试）。
   * @returns {Promise<boolean>} true = 有后端且需要登录
   */
  function ensureReady() {
    if (probeDone.value) return Promise.resolve(!authDisabled.value);
    if (probePromise) return probePromise;
    probePromise = detectBackend()
      .then((result) => {
        backendAvailable.value = result.available;
        const loginRequired = result.available && result.requireLogin !== false;
        authDisabled.value = !loginRequired;
        probeReason.value = !result.available
          ? result.reason || "未检测到后端接口"
          : loginRequired
            ? ""
            : "后端已关闭登录校验（REQUIRE_LOGIN=0）";
        if (!result.available) {
          // 没有后端就别留着过期的登录态，否则页面会出现「已登录但接口 404」
          token.value = null;
          user.value = null;
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(USER_KEY);
        }
        return loginRequired;
      })
      .finally(() => {
        probeDone.value = true;
        probePromise = null;
      });
    return probePromise;
  }

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
    // 没有后端（静态部署）时登录本就不成立，直接放行
    if (authDisabled.value) return { success: true };
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

  /**
   * 自助修改密码（普通用户也能用）。
   * 成功后后端会把 tokenEpoch +1，当前 token 立即失效，所以这里顺带登出。
   * @param {string} oldPassword 当前密码
   * @param {string} newPassword 新密码
   * @returns {Promise<{success: boolean, message?: string}>} 是否成功及失败原因
   */
  const changePassword = async (oldPassword, newPassword) => {
    try {
      const res = await fetch("/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { success: false, message: data.error || "修改失败" };
      }
      return { success: true };
    } catch (error) {
      return { success: false, message: error?.message || "网络异常" };
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

  /** 应用启动时恢复登录态（先确认后端在，再验 token） */
  const initAuth = async () => {
    await ensureReady();
    if (authDisabled.value || !token.value) return;
    await fetchUserInfo();
  };

  return {
    user,
    token,
    isLoading,
    backendAvailable,
    authDisabled,
    probeReason,
    isAuthenticated,
    isAdmin,
    userInfo,
    login,
    register,
    logout,
    changePassword,
    fetchUserInfo,
    initAuth,
    ensureReady,
    authHeaders,
  };
});
