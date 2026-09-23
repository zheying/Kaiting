# 代理协作说明

这个仓库是一个面向个人 NAS 音乐库的 TypeScript 单仓库，包含 React/Vite 客户端和 Fastify/SQLite 服务端。应用将音乐目录视为只读，所有可变状态都写入 `DATA_DIR`。

## 当前结构

- 客户端：`src/client/App.tsx`、`src/client/styles.css`、`src/client/api.ts`。
- 服务端：`src/server/index.ts`、`src/server/routes.ts`、`src/server/db.ts`、`src/server/scanner.ts`。
- 共享类型：`src/shared/types.ts`。
- 测试：`tests/`。
- 生产构建输出：`dist/`。
- 运行时数据：默认写入 `data/`。

## 运行命令

```bash
npm run typecheck
npm test
npm run build
```

开发模式：

```bash
npm run dev
```

本地生产运行（先按 README 配置 `.env` 中的密码、随机密钥、音乐路径和 Cookie 传输方式）：

```bash
NODE_ENV=production \
node --env-file=.env dist/server/server/index.js
```

Docker：

```bash
docker compose up --build
```

## 实现规则

- 不要修改音乐库目录中的任何文件。扫描器和 API 必须保持曲库只读。
- 所有用户数据都放在 `DATA_DIR`：包括 SQLite 数据库、封面缓存、元数据缓存、歌单、收藏和扫描记录。
- 任何基于歌曲记录或请求参数推导出的路径，都必须经过 `safeRealPath`。
- 浏览器兼容的格式优先直传。只有在 `shouldTranscode(track)` 返回需要，或者请求显式使用 `mode=transcode` 时才调用 FFmpeg。
- 保持现有 M4A 规则：AAC M4A 直接播放，ALAC M4A 走转码。
- UI 文案默认保持中文。
- 除非任务明确要求多账号，否则维持单用户应用模型。
- 纯 UI 改动避免引入重量级前端依赖。

## 前端说明

- 路由使用 hash URL，例如 `#/albums`、`#/album/:key`、`#/playing`。
- 底部播放器有意参考 Apple Music Web，包含桌面、紧凑和移动端布局。
- 用户偏好移动端底部播放器的胶囊造型；后续排版与触控优化应保留这一外形。
- 移动端布局由 `useMobileLayout()` 优先根据手机 UA 决定；非 iPad 浏览器在小于 480 CSS px 时也使用移动布局，并响应窗口宽度变化。iPad（含桌面 UA 的 iPadOS）仍视为桌面/平板。
- 全屏播放页分桌面和移动端两套样式路径。移动端包含：
- 封面居中布局。
- 播放/暂停时的封面尺寸动画。
- 移动端待播清单面板。
- 底部歌词/队列切换标签。
- 桌面浏览器的最小宽度是有意为之。除非任务明确要求调整移动 UA 布局，不要把它改成完全随宽度无限收缩的实现。

## 服务端说明

- 主要 API 路由位于 `src/server/routes.ts`。
- 只有在 `NODE_ENV=production` 时才托管前端静态文件；否则 `/*` 会返回 JSON，提示使用 Vite 开发服务。
- 生产环境必须提供 `ADMIN_PASSWORD` 和至少 32 字符的私有随机 `COOKIE_SECRET`。
- 生产环境默认 `COOKIE_SECURE=true`；可信局域网 HTTP 直连必须显式配置 `COOKIE_SECURE=false`，HTTPS 反向代理保持 `true`。
- 开发环境默认登录密码是 `admin`。
- 在线元数据补全是可选能力，由 `ENABLE_ONLINE_METADATA` 控制。
- 扫描默认增量且保留缺失索引；显式 `prune` 也必须通过完整遍历、无错误及挂载检查，不能削弱空库/部分目录丢失保护。
- 服务和数据维护命令共用 `DATA_DIR/.runtime-lock.sqlite` 的独占锁；仅服务取得锁后执行遗留扫描恢复，不能在普通 `openDatabase()` 时把其他连接的活动扫描标记失败。
- 备份/恢复实现位于 `src/server/maintenance.ts`；恢复只允许新/空目录，必须验证文件与数据库完整性并重定位缓存路径，不自动迁移音乐路径或歌曲 ID。

## 验证

交付代码前运行：

```bash
npm run typecheck
npm run build
git diff --check
```

当改动涉及扫描、音频格式识别、路径安全、数据库行为或 API 合同时，额外运行 `npm test`。
