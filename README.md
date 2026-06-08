# NAS Music Library

一个面向个人 NAS 的音乐管理 Web/PWA。应用只读扫描音乐目录，把索引、封面缓存、歌词引用、歌单和收藏写入 `/data`，并通过网页提供浏览、搜索和播放。

## 功能

- 单用户登录，适合局域网或反向代理后部署。
- 支持 `mp3`、`m4a/aac`、`flac`、`alac`、`ogg`、`opus`、`wav`。
- AAC M4A、MP3、OGG、OPUS、WAV 优先原文件直传；ALAC M4A、FLAC 和不兼容格式按需通过 FFmpeg 转 MP3 流。
- 扫描本地标签、内嵌封面、同目录封面和 `.lrc` 歌词。
- 可选在线元数据补全：本地标签优先，缺失时查询 MusicBrainz、Cover Art Archive、LRCLIB，并把结果缓存到 `/data`。
- 扫描失败会保留最近任务的错误文件路径和原因，方便定位损坏音频。
- 专辑、艺人、歌曲、搜索、收藏、歌单和播放队列。

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

在线元数据补全不会修改音乐文件；音乐目录保持只读。补全结果会写到 `/data/metadata` 和 `/data/artwork`，服务离线时扫描仍会继续使用本地标签。

## 本地开发

```bash
npm install
npm run dev
```

默认后端地址是 `http://localhost:3000`，前端开发地址是 `http://localhost:5173`。如果没有设置 `ADMIN_PASSWORD`，开发环境默认密码是 `admin`。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

## API 速览

- `POST /api/scan`：启动扫描。
- `GET /api/scan`：查看最近扫描状态。
- `GET /api/scan/errors`：查看最近扫描任务的错误文件。
- `GET /api/metadata/status`：查看在线元数据开关、提供方和缓存数量。
