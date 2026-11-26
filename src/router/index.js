import { createRouter, createWebHistory } from "vue-router";
import * as autoRoutes from "vue-router/auto-routes";
import { useAuthStore } from "@/stores/auth";
import { useTokenStore } from "@/stores/tokenStore";
import { isNowInLegionWarTime } from "@/utils/clubBattleUtils";

const generatedRoutes = autoRoutes.routes ?? [];

const my_routes = [
  {
    path: "/",
    name: "Home",
    component: () => import("@/views/Home.vue"),
    meta: {
      title: "首页",
      requiresToken: false,
    },
  },
  {
    path: "/tokens",
    name: "TokenImport",
    component: () => import("@/views/TokenImport/TokenImport.vue"),
    meta: {
      title: "Token管理",
      requiresToken: false,
    },
    props: (route) => ({
      token: route.query.token,
      name: route.query.name,
      server: route.query.server,
      wsUrl: route.query.wsUrl,
      api: route.query.api,
      auto: route.query.auto === "true",
    }),
  },
  {
    path: "/game",
    name: "GamePlayer",
    component: () => import("@/views/GamePlayer.vue"),
    meta: {
      title: "游戏",
      requiresToken: true,
    },
    props: (route) => ({
      bin_id: route.query.bin_id,
    }),
  },
  {
    path: "/multi-game",
    name: "GameMultiPlayer",
    component: () => import("@/views/GameMultiPlayer.vue"),
    meta: {
      title: "批量游戏",
      requiresToken: true,
    },
  },
  {
    name: "DefaultLayout",
    path: "/admin",
    component: () => import("@/layout/DefaultLayout.vue"),
    children: [
      {
        path: "dashboard",
        name: "Dashboard",
        component: () => import("@/views/Dashboard.vue"),
        meta: {
          title: "控制台",
          requiresToken: true,
        },
      },
      {
        path: "game-features",
        name: "GameFeatures",
        component: () => import("@/views/GameFeatures.vue"),
        meta: {
          title: "游戏功能",
          requiresToken: true,
        },
      },
      {
        path: "message-test",
        name: "MessageTest",
        component: () => import("@/components/Test/MessageTester.vue"),
        meta: {
          title: "消息测试",
          requiresToken: true,
        },
      },
      {
        // 临时实验台：验证十殿组队协议（matchteam_create/join/memberprepare）
        path: "nightmare-lab",
        name: "NightmareTeamLab",
        component: () => import("@/views/NightmareTeamLab.vue"),
        meta: {
          title: "十殿组队实验台",
          requiresToken: true,
        },
      },
      {
        path: "legion-war",
        name: "LegionWar",
        component: () => import("@/views/LegionWar.vue"),
        meta: {
          title: "实时盐场",
          requiresToken: true,
        },
      },
      {
        path: "profile",
        name: "Profile",
        component: () => import("@/views/Profile.vue"),
        meta: {
          title: "个人设置",
          requiresToken: true,
        },
      },
      // Full backup / restore page (export or import all accounts + config).
      {
        path: "backup",
        name: "BackupRestore",
        component: () => import("@/views/BackupRestore.vue"),
        meta: {
          title: "备份恢复",
          requiresToken: true,
        },
      },
      {
        path: "daily-tasks",
        name: "DailyTasks",
        component: () => import("@/views/DailyTasks.vue"),
        meta: {
          title: "日常任务",
          requiresToken: true,
        },
      },
      {
        path: "batch-daily-tasks",
        name: "BatchDailyTasks",
        component: () => import("@/views/BatchDailyTasks.vue"),
        meta: {
          title: "批量日常",
          requiresToken: true,
        },
      },
      {
        path: "PushingLevels",
        name: "PushingLevels",
        component: () => import("@/views/PushingLevels.vue"),
        meta: {
          title: "主线推关",
          requiresToken: true,
        },
      },
      // 增加自动路由引用
      ...generatedRoutes,
    ],
  },
  {
    path: "/websocket-test",
    name: "WebSocketTest",
    component: () => import("@/components/Test/WebSocketTester.vue"),
    meta: {
      title: "WebSocket测试",
      requiresToken: true,
    },
  },
  {
    path: "/admin/users",
    name: "UserManage",
    component: () => import("@/views/admin/UserManage.vue"),
    meta: {
      title: "用户管理",
      requiresToken: false,
    },
  },
  {
    path: "/login",
    name: "Login",
    component: () => import("@/views/Login.vue"),
    meta: {
      title: "登录",
      requiresToken: false,
      requiresAuth: false,
    },
  },
  {
    path: "/register",
    redirect: "/tokens",
  },
  {
    path: "/game-roles",
    redirect: "/tokens",
  },
  // 增加自动路由引用
  ...generatedRoutes,
  {
    path: "/:pathMatch(.*)*",
    name: "NotFound",
    component: () => import("@/views/NotFound.vue"),
    meta: {
      title: "页面不存在",
    },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes: my_routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) {
      return savedPosition;
    } else {
      return { top: 0 };
    }
  },
});

// 热更新路由
autoRoutes.handleHotUpdate?.(router);

// 导航守卫
router.beforeEach((to, from, next) => {
  const tokenStore = useTokenStore();
  const authStore = useAuthStore();

  // 设置页面标题
  document.title = to.meta.title
    ? `${to.meta.title} - XYZW 游戏管理系统`
    : "XYZW 游戏管理系统";
  // 登录页：已登录直接进后台，未登录放行
  if (to.path === "/login" || to.meta.requiresAuth === false) {
    if (to.path === "/login" && authStore.isAuthenticated) {
      next("/admin/dashboard");
      return;
    }
    next();
    return;
  }

  // 其余页面一律要求登录（白名单用户）
  if (!authStore.isAuthenticated) {
    next({ path: "/login", query: { redirect: to.fullPath } });
    return;
  }

  // 后台推关只给管理员（菜单已隐藏，这里拦住直接输网址的情况）
  if (to.name === "PushingLevels" && !authStore.isAdmin) {
    next("/admin/dashboard");
    return;
  }

  if (to.name === "LegionWar" && !isNowInLegionWarTime()) {
    next("/admin/dashboard");
    return;
  }
  // 检查是否需要Token
  if (to.meta.requiresToken && !tokenStore.hasTokens) {
    next("/tokens");
  } else if (to.path === "/" && tokenStore.hasTokens) {
    // 首页重定向逻辑
    if (tokenStore.selectedToken) {
      next("/admin/dashboard");
    } else {
      next("/tokens");
    }
  } else {
    next();
  }
});

export default router;
