# NAS Music Library

一个面向个人 NAS 的音乐管理 Web/PWA。应用只读扫描音乐目录，把索引、封面缓存、歌词引用、歌单和收藏写入持久化数据目录，并提供漂亮的桌面、平板和手机网页播放体验。

## 功能

- 单用户登录，适合局域网、Tailscale/ZeroTier、VPN 或反向代理后部署。
- 只读扫描音乐目录，不修改标签、不移动文件、不重命名文件。
- 默认增量扫描，跳过未变化的已处理文件；服务中断后可重新扫描，缺失索引清理需单独确认。
- 支持 `mp3`、`m4a/aac`、`flac`、`alac`、`ogg`、`opus`、`wav`。
- AAC M4A、MP3、OGG、OPUS、WAV 优先原文件直传；ALAC M4A、FLAC 和不兼容格式按需通过 FFmpeg 转 MP3 流。
- 扫描本地标签、内嵌封面、同目录封面和 `.lrc` 歌词。
- SQLite + FTS 搜索，支持歌曲、专辑、艺人和全文搜索。
- 专辑墙、艺人页、搜索页、收藏、歌单、专辑详情、歌曲列表。
- 歌曲、收藏、专辑、艺人和各类搜索结果支持分页与总数；搜索地址可在刷新和浏览器返回时恢复。
- 歌单支持创建、添加/移除歌曲、重命名、删除和保存歌曲顺序；并发排序会提示冲突，保留当前播放队列。
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
# 编辑 .env，填写密码、随机密钥和主机曲库路径，再启动。
docker compose up -d --build
```

部署前编辑 `.env`，设置自己的 `ADMIN_PASSWORD`，并把 `openssl rand -hex 32` 生成的随机字符串填入 `COOKIE_SECRET`。生产环境会拒绝缺失、少于 32 字符或仍使用仓库公开示例的密钥。密钥应持久保留；更换密钥会使已有登录失效。

把 `MUSIC_LIBRARY_PATH` 改成 NAS 主机上已经挂载的真实音乐目录。Compose 自动读取 `.env`，将该目录只读挂载到容器 `/music`，将主机 `DATA_DIR` 挂载到容器 `/data`，并把主机 `PORT` 转发至容器固定端口 `3000`。修改 `.env` 后重新执行 `docker compose up -d`，让配置生效。

容器使用 `unless-stopped` 重启策略、进程回收和健康检查，日志最多保留 3 个 10 MB 文件。主机还需让 Docker 随系统或用户登录启动，并关闭自动睡眠。可用 `docker compose ps` 查看健康状态；健康检查失败本身不会触发 Docker 自动重启，异常退出才会按重启策略恢复。`MUSIC_LIBRARY_IMAGE` 可指定已构建的镜像标签，默认 `music-library:local`。

若音乐来自另一台 NAS，可使用 [docker-compose.nfs.yml](docker-compose.nfs.yml) 将 `/music` 改为只读 NFS Docker 卷，`/data` 仍放在运行容器的主机磁盘上。需要先创建 NFS 卷，并在 `.env` 设置 `NAS_MUSIC_VOLUME`；`MUSIC_LIBRARY_PATH` 仍需填写 NAS 路径，以满足基础配置合并前的插值检查。使用 `docker compose -f docker-compose.yml -f docker-compose.nfs.yml up -d --build` 启动，或将该配置复制为部署目录的 `docker-compose.override.yml` 自动加载。实际部署、NFS 参数和维护命令见 [192.0.2.10 部署记录](docs/docker-deployment-2026-09-22.md)。

浏览器通过 HTTPS（包括反向代理提供的 HTTPS）访问时，保持 `COOKIE_SECURE=true`。如果只在可信局域网内直接通过 `http://NAS地址:3000` 访问，需显式设置 `COOKIE_SECURE=false`，否则浏览器不会通过 HTTP 发送登录 Cookie。该选项只控制 Cookie，不会为服务启用 HTTPS；从外网访问应通过 HTTPS 或 VPN。

常用环境变量：

- `ADMIN_PASSWORD`：登录密码，生产环境必填。
- `COOKIE_SECRET`：Cookie 签名密钥，生产环境必填，至少 32 字符，使用随机生成值。
- `COOKIE_SECURE`：Cookie 是否仅通过 HTTPS 发送；生产默认 `true`，开发默认 `false`。可信局域网 HTTP 部署需显式设置 `false`。
- `MUSIC_LIBRARY_PATH`：本地运行时是曲库路径；Compose 的 `.env` 中是主机曲库路径，容器内固定 `/music`。
- `DATA_DIR`：本地运行时是数据库、封面和在线元数据缓存目录；Compose 的 `.env` 中是主机持久化路径，默认 `./data`，容器内固定 `/data`。
- `ENABLE_ONLINE_METADATA`：设为 `true` 后启用缺失标签、封面、歌词的在线补全。
- `PORT`：本地运行时是服务监听端口；Compose 中是主机发布端口，默认 `3000`，容器内部固定 `3000`。

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

再复制并编辑 `.env`，填写密码、随机密钥和本机实际曲库路径。Node.js 不会自动加载 `.env`，可使用 Node.js 22 及以上版本的 `--env-file` 参数启动：

```bash
NODE_ENV=production \
node --env-file=.env dist/server/server/index.js
```

生产模式会由 Fastify 托管 `dist/client`。通过本地 HTTP 或局域网 HTTP 直接访问时，将 `.env` 中的 `COOKIE_SECURE` 设为 `false`；通过 HTTPS 反向代理访问时保持 `true`。

## 播放兼容性

- 原文件直传：浏览器可播放的 MP3、AAC M4A、OGG、OPUS、WAV 等格式。
- 按需转码：FLAC、ALAC M4A 或浏览器不兼容的格式。
- M4A 规则：AAC M4A 优先直传；ALAC M4A 转码。
- 转码输出：当前使用 FFmpeg 输出 MP3 流。

系统需要能在运行环境中执行 `ffmpeg`。Docker 镜像会安装 FFmpeg；本地运行时请自行安装。

## 浏览与播放全部

歌曲、收藏、专辑和艺人列表通过“上一页 / 下一页”浏览完整曲库。搜索会分别显示歌曲、专辑、艺人的匹配总数，各分类独立翻页。搜索关键词保存在 `#/search/关键词` 地址中。

在歌曲或收藏列表点击单曲，会从这首歌开始播放当前页。要播放整个曲库、全部收藏或全部搜索结果，点击对应的“播放全部”按钮；全部歌曲加载完成后，点击“开始播放（N 首）”。准备期间可取消，失败可重试；当前播放队列会在确认开始播放时替换。专辑、艺人及歌单详情的播放按钮使用该详情内的完整歌曲列表。

## 扫描与中断恢复

“扫描曲库”默认执行增量扫描，处理新增、音频属性变化、本地歌词/封面变化或缓存失效的歌曲，跳过已处理且未变化的文件。首次升级后的扫描会建立增量记录，仍需读取全部音频；之后重扫会显示已检查、重新解析、跳过和错误数。

“扫描选项”提供“重新解析全部”，用于重新读取全部音频元数据，并在启用在线补全时重试相关查询。它耗时更长，但仍保留收藏和歌单。元数据解析失败的文件不会记作成功，下次扫描会重新尝试。

默认扫描保留暂时失踪的索引。确实删除音乐后，可在确认 NAS 及所有子目录完整挂载的情况下，选择“清理缺失索引…”并确认。只有非空、完整、无错误的扫描才执行清理；曲库为空、目录或挂载身份变化、权限不足、音频解析错误均阻止清理。清理会移除失踪歌曲的索引及收藏、歌单关联，音乐文件始终只读。整段原目录已消失时也会保守拒绝清理，不能用此操作自动迁移曲库挂载路径。

服务异常退出后，再次启动会把遗留的“扫描中”标记为失败并保留进度；点击“重新扫描”后，已完成且未变的文件会跳过。应用不会在启动时自动开始长时间扫描。同一个 `DATA_DIR` 仅允许一个服务或维护命令使用，进程退出后占用自动释放。

## 数据备份与恢复

先执行 `npm run build`。备份前停止当前音乐服务，再使用已有 `.env` 的配置运行：

```bash
node --env-file=.env dist/server/server/maintenance.js backup
```

也可以显式指定目录：

```bash
npm run data:backup -- --data-dir ./data --music-library-path "/实际音乐目录"
```

命令输出完整备份目录，默认位于 `DATA_DIR/backups/backup-时间-标识/`。备份包括 SQLite 快照、`artwork`、`metadata`、文件清单及 SHA-256 校验值，涵盖收藏、歌单、扫描记录和缓存；不复制音乐文件、`.env` 或旧备份。SQLite 快照包含已提交的 WAL 数据。运行中的服务会阻止备份，避免数据库与缓存来自不同时刻。可用 `--backup-root` 指定另一处备份父目录；不能放进音乐目录或正在备份的缓存目录。

恢复必须使用新目录或空目录，命令会拒绝覆盖原有数据：

```bash
node --env-file=.env dist/server/server/maintenance.js restore \
  --backup "./data/backups/实际备份目录" \
  --data-dir "./data-restored"
```

恢复会检查每个文件及 SQLite 完整性，再更新指向旧 `DATA_DIR` 的缓存引用。音乐文件路径与歌曲 ID 保持原样，因此曲库仍应挂载在原路径；本机路径与 Docker 的 `/music` 之间迁移不在此工具的范围内。恢复完成后，将 `.env` 的 `DATA_DIR` 改为恢复目录，再按原方式启动服务，检查收藏、歌单、歌词及播放。保留原数据目录，确认恢复结果后再自行归档。

若恢复进程被中断，未完成目录会保留恢复标记并拒绝启动；请换另一个新目录重试，不要删除标记后强行启动。密码与 Cookie 密钥需另行保存，备份工具不会读取或复制 `.env`。默认备份与数据在同一位置，完成的备份目录应另存一份，以应对原磁盘故障。

维护命令可读取环境变量 `DATA_DIR`、`MUSIC_LIBRARY_PATH`，但不会自动加载 `.env`。`npm run data:backup -- --help` 和 `npm run data:restore -- --help` 可查看参数。容器中的维护命令应沿用服务的路径映射，并在原服务停止后执行。

## 整理歌单

从歌曲的“更多”菜单添加到已有歌单，或新建歌单并添加。歌单详情支持重命名、从歌单移除歌曲，以及“调整顺序”：使用上移/下移按钮整理，点击“保存顺序”提交，或取消放弃草稿。若另一个页面已修改歌单，保存会提示冲突；放弃草稿并重新加载后再调整。

重命名、移除、调整顺序和删除歌单都会保留当前播放队列；新顺序在下次点击“播放歌单”时生效。删除歌单需要确认，仅删除歌单和歌曲关联，不删除音乐文件或收藏。网络失败会显示错误并保留可重试的操作入口。

## API 速览

- `POST /api/auth/login`：登录。
- `POST /api/auth/logout`：退出登录。
- `GET /api/me`：当前用户与服务配置。
- `POST /api/scan`：启动扫描，省略请求体为默认增量；可传 `{ force: true }` 重新解析或 `{ prune: true }` 启用缺失索引清理。
- `GET /api/scan`：查看最近扫描状态。
- `GET /api/scan/errors`：查看最近扫描任务的错误文件。
- `GET /api/summary`：曲库统计。
- `GET /api/tracks`：歌曲列表，支持 `q`、`limit`、`offset`、`favorite`、`page`。
- `GET /api/tracks/:id`：歌曲详情。
- `PATCH /api/tracks/:id/favorite`：收藏/取消收藏。
- `GET /api/tracks/:id/artwork`：封面。
- `GET /api/tracks/:id/lyrics`：歌词。
- `GET /api/tracks/:id/stream`：音频流，支持 `mode=auto|direct|transcode`。
- `GET /api/search`：全库搜索预览，最多返回 25 首歌曲、12 张专辑、12 位艺人；完整结果使用对应列表接口的 `q` 和分页参数。
- `GET /api/albums`、`GET /api/albums/:key`：专辑列表和详情；列表支持 `q`、`limit`、`offset`、`page`。
- `GET /api/artists`、`GET /api/artists/:name`：艺人列表和详情；列表支持 `q`、`limit`、`offset`、`page`。
- `GET /api/playlists`、`POST /api/playlists`：歌单列表和创建。
- `GET /api/playlists/:id`：歌单详情。
- `PATCH /api/playlists/:id`：重命名，请求 `{ name }`，去除首尾空白后须为 1–200 个字符。
- `DELETE /api/playlists/:id`：删除歌单及歌曲关联。
- `POST /api/playlists/:id/tracks`：添加歌曲到歌单。
- `DELETE /api/playlists/:id/tracks/:trackId`：从歌单移除歌曲。
- `PUT /api/playlists/:id/tracks/order`：请求 `{ trackIds, revision }`，一次保存完整歌曲顺序。
- `GET /api/metadata/status`：在线元数据开关、提供方和缓存数量。

三个列表接口添加 `page=true` 时返回 `{ items, total, limit, offset, revision }`，`total` 是应用筛选后的总数，`revision` 用于发现跨页加载期间的数据变化。`limit` 范围为 1–500，`offset` 为非负整数；排序包含唯一字段，稳定数据下翻页不会重复或遗漏。省略 `page` 或设为 `false` 仍返回数组，兼容原有调用。歌曲默认每页 80 首，专辑和艺人默认每页 200 项。

扫描记录包含 `scannedFiles`（已检查）、`parsedFiles`（成功重新解析）、`skippedFiles`（未变跳过）、`errorCount`，以及 `force`/`prune` 选项。只有重新扫描会产生新任务；读取状态不会自动启动扫描。

歌单详情及添加、移除、排序成功后返回 `{ playlist, tracks, revision }`（移除接口同时保留 `ok: true`）。排序必须提交当前歌单全部成员的无重复排列及读取时的版本；歌单名称、描述或有序成员有变化时返回 `409`，不会写入部分顺序。不存在的歌单返回 `404`，非法参数返回 `400`。重复添加不会重复歌曲，重复移除可安全重试。

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
