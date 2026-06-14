# NAS Music Library

一个面向个人 NAS 的音乐管理 Web/PWA。应用只读扫描音乐目录，把索引、封面缓存、歌词引用、歌单和收藏写入持久化数据目录，并提供漂亮的桌面、平板和手机网页播放体验。

## 功能

- 单用户登录，适合局域网、Tailscale/ZeroTier、VPN 或反向代理后部署。
- 只读扫描音乐目录，不修改标签、不移动文件、不重命名文件。
- 支持 `mp3`、`m4a/aac`、`flac`、`alac`、`ogg`、`opus`、`wav`。
- AAC M4A、MP3、OGG、OPUS、WAV 优先原文件直传；ALAC M4A、FLAC 和不兼容格式按需通过 FFmpeg 转 MP3 流。
- 扫描本地标签、内嵌封面、同目录封面和 `.lrc` 歌词。
- SQLite + FTS 搜索，支持歌曲、专辑、艺人和全文搜索。
- 专辑墙、艺人页、搜索页、收藏、歌单、专辑详情、歌曲列表。
- 网页播放器、播放队列、进度拖动、音量控制、静音、随机播放、正常/单曲循环/列表循环。
- 播放页支持桌面和移动端布局；移动端参考 Apple Music Web，包含封面缩放动画和待播清单视图。
- 可选在线元数据补全：本地标签优先，缺失时查询 MusicBrainz、Cover Art Archive、LRCLIB，并把结果缓存到数据目录。
- 扫描失败会保留最近任务的错误文件路径和原因，方便定位损坏音频。

## 技术栈

- 前端：React、Vite、TypeScript、Lucide icons。
- 后端：Fastify、TypeScript。
- 数据库：SQLite，包含全文搜索索引。
- 音频：浏览器直传 + FFmpeg 按需转码。
- 部署：Docker Compose 或本地 Node.js。

## Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

部署前把 `docker-compose.yml` 里的 `/path/to/your/music` 改成 NAS 上的音乐目录。该目录以只读方式挂载到容器内 `/music`。

常用环境变量：

- `ADMIN_PASSWORD`：登录密码，生产环境必填。
- `COOKIE_SECRET`：Cookie 签名密钥，生产环境建议设置为长随机字符串。
- `MUSIC_LIBRARY_PATH`：容器内音乐目录，Compose 默认是 `/music`。
- `DATA_DIR`：数据库、封面和在线元数据缓存目录，Compose 默认是 `/data`。
- `ENABLE_ONLINE_METADATA`：设为 `true` 后启用缺失标签、封面、歌词的在线补全。
- `PORT`：服务监听端口，默认 `3000`。

在线元数据补全不会修改音乐文件；音乐目录保持只读。补全结果会写到 `DATA_DIR/metadata` 和 `DATA_DIR/artwork`，服务离线时扫描仍会继续使用本地标签。

## 本地开发

```bash
npm install
npm run dev
```

本地调试入口固定为 `http://localhost:3000`。开发模式下 Vite 监听 `3000`，Fastify API 监听内部端口 `3001` 并由 Vite 代理 `/api`。如果没有设置 `ADMIN_PASSWORD`，开发环境默认密码是 `admin`。

开发模式下请直接打开 `http://localhost:3000/` 查看前端。

## 本地生产运行

先构建：

```bash
npm run build
```

再启动：

```bash
NODE_ENV=production \
ADMIN_PASSWORD=admin \
MUSIC_LIBRARY_PATH="/path/to/music" \
DATA_DIR="./data" \
PORT=3000 \
node dist/server/server/index.js
```

生产模式会由 Fastify 托管 `dist/client`，访问 `http://localhost:3000/` 即可打开完整应用。

## 播放兼容性

- 原文件直传：浏览器可播放的 MP3、AAC M4A、OGG、OPUS、WAV 等格式。
- 按需转码：FLAC、ALAC M4A 或浏览器不兼容的格式。
- M4A 规则：AAC M4A 优先直传；ALAC M4A 转码。
- 转码输出：当前使用 FFmpeg 输出 MP3 流。

系统需要能在运行环境中执行 `ffmpeg`。Docker 镜像会安装 FFmpeg；本地运行时请自行安装。

## API 速览

- `POST /api/auth/login`：登录。
- `POST /api/auth/logout`：退出登录。
- `GET /api/me`：当前用户与服务配置。
- `POST /api/scan`：启动扫描。
- `GET /api/scan`：查看最近扫描状态。
- `GET /api/scan/errors`：查看最近扫描任务的错误文件。
- `GET /api/summary`：曲库统计。
- `GET /api/tracks`：歌曲列表，支持 `q`、`limit`、`offset`、`favorite`。
- `GET /api/tracks/:id`：歌曲详情。
- `PATCH /api/tracks/:id/favorite`：收藏/取消收藏。
- `GET /api/tracks/:id/artwork`：封面。
- `GET /api/tracks/:id/lyrics`：歌词。
- `GET /api/tracks/:id/stream`：音频流，支持 `mode=auto|direct|transcode`。
- `GET /api/search`：搜索歌曲、专辑、艺人。
- `GET /api/albums`、`GET /api/albums/:key`：专辑列表和详情。
- `GET /api/artists`、`GET /api/artists/:name`：艺人列表和详情。
- `GET /api/playlists`、`POST /api/playlists`：歌单列表和创建。
- `GET /api/playlists/:id`：歌单详情。
- `POST /api/playlists/:id/tracks`：添加歌曲到歌单。
- `DELETE /api/playlists/:id/tracks/:trackId`：从歌单移除歌曲。
- `GET /api/metadata/status`：在线元数据开关、提供方和缓存数量。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

UI 或样式调整至少运行：

```bash
npm run typecheck
npm run build
git diff --check
```

扫描、路径安全、音频格式、数据库或 API 变更应同时运行 `npm test`。

## 协作说明

面向代码代理和自动化协作者的项目约束写在 `AGENTS.md`。`CLAUDE.md` 保留为 Claude/Cursor 等工具的入口，并指向同一套约束。
