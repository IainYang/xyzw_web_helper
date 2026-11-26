import naive from "naive-ui";
import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import router from "./router";
import { useAuthStore } from "./stores/auth";
import { startBgTicker } from "./utils/bgTicker";
import { initFrontendLog, logInfo } from "./utils/frontendLog";
import "@arco-design/web-vue/dist/arco.css";
import "virtual:uno.css";
import "./assets/styles/global.scss";

// 前端埋点：异常 + 关键事件上报到本地后端（render-backend/logs/）
initFrontendLog();

// 所有走本地后端的请求自动带上登录 token（x-user-token，不与 API Key 抢 Authorization）
const rawFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url || "";
  const isBackend = url.startsWith("/api") || url.startsWith("/auth");
  if (isBackend) {
    const authToken = localStorage.getItem("xyzw_auth_token");
    if (authToken) {
      init.headers = { ...(init.headers || {}), "x-user-token": authToken };
    }
  }
  return rawFetch(input, init);
};

// 记录页面访问路径，便于按会话还原操作轨迹
router.afterEach((to, from) => {
  logInfo("路由切换", { to: to.fullPath, from: from.fullPath });
});

// 创建应用实例
const app = createApp(App);

// 使用插件
app.use(createPinia());
app.use(router);
app.use(naive);

// 恢复登录态：本地有 token 就去后端验一次，失效则清理
useAuthStore().initAuth();

// 全局主题应用：从 localStorage 读取并设置 data-theme 属性
const applyTheme = () => {
  const saved = localStorage.getItem("theme") || "auto";
  if (saved === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else if (saved === "light") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    const prefersDark =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (prefersDark)
      document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");

    // 跟随系统变更
    if (window.matchMedia) {
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", (e) => {
          const t = localStorage.getItem("theme") || "auto";
          if (t === "auto") {
            if (e.matches)
              document.documentElement.setAttribute("data-theme", "dark");
            else document.documentElement.removeAttribute("data-theme");
          }
        });
    }
  }
};

applyTheme();

// 挂载应用
startBgTicker();
app.mount("#app");
