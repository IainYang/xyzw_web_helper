import dotenv from "dotenv";

/**
 * 环境变量加载（必须是 server.js 的第一个 import）。
 *
 * ESM 的 import 会先于模块体执行，而 `dotenv.config()` 原来写在 server.js 的
 * 代码体里 —— 于是 authStore / authToken / syncStore 这些在**模块顶层**读
 * `process.env` 的文件，拿到的全是 undefined：
 * - AUTH_DATA_DIR 不生效（白名单仍读代码目录，部署时会被覆盖）
 * - AUTH_SECRET 不生效（token 用兜底密钥签名）
 *
 * 把 config() 独立成一个模块并放在 import 列表最前面，就能保证它先跑。
 */
dotenv.config();
