# 音泊工程化版本正式部署

> 隐私说明：环境地址和路径已替换为示例；原始验收附件在仓库外私有保存，不随仓库发布。

日期：2026-09-28。目标：`user@192.0.2.10` 的 OrbStack Docker，部署目录 `/srv/music-library`。

访问地址：[音泊](http://192.0.2.10:3002/#/home)。新版容器运行正常，Docker 健康状态为 `healthy`。

## 发布内容

正式客户端采用定稿原型，接入真实登录、账号、曲库、目录扫描、收藏、歌单、歌词和播放服务。首次升级创建 `admin` 管理员，初始密码沿用部署环境已有的 `ADMIN_PASSWORD`；原有收藏和歌单归入该账号。旧会话需重新登录。

- 新镜像：`music-library:2026-09-28-engineering`，Linux/ARM64。
- 镜像 ID：`sha256:ac00195fafff18b994d3bb6d373139161ca053f8de521c38a186c252996ea0a9`。
- 原镜像保留：`music-library:2026-09-23-multidisc`，ID `sha256:03044087c861c0e142c6ebcbc062ea71ba790a9c3bf165c5d7aca94dc17e16a6`。
- 发布依据为本地工作区快照；未额外执行 Git commit。源代码归档在远端 `releases/2026-09-28-engineering/music-library-engineering-20260928.tar`。
- 源归档 SHA-256：`254c1850256d03f5bf2ff6e0f74d523f6b0b2425fba01b0c470bf8c66118e9b8`，同时记录于镜像标签 `music-library.source-sha256`。
- 运行配置只更新 `MUSIC_LIBRARY_IMAGE`，保留原凭据、端口、数据路径和 NFS 覆盖配置。旧 `.env` 与 Compose 配置保存在同一发布目录，未复制到仓库。

音乐挂载仍为 `music-library-nas-music → /music`，`RW=false`。数据仍为 `/srv/music-library/data-nas → /data`。其他容器的 ID 与镜像未改变。

## 备份与迁移校验

切换前停止服务，使用旧镜像的维护命令生成备份，并校验清单中全部 867 个文件的大小与 SHA-256：

```text
/srv/music-library/data-nas/backups/backup-2026-09-28T04-07-17.653Z-8d079584-2334-4a4c-a10e-89628853a1e9
```

备份路径记录在远端 `releases/2026-09-28-engineering/backup.path.txt`。本次没有执行扫描、清理或修改任何 NAS 音乐文件。

| 校验项 | 升级前 | 升级后 |
| --- | --- | --- |
| 歌曲 | 1,045 | 1,045 |
| 专辑 | 12 | 12 |
| 收藏歌曲 | 0 | 0 |
| 歌单 | 2 | 2，归属 admin |
| 歌单成员 | 0 | 0 |
| 扫描记录 | 3 | 3 |
| SQLite 完整性 | ok | ok |
| 外键错误 | 0 | 0 |

歌曲完整记录、歌单内容、成员顺序、收藏及扫描记录的 SHA-256 摘要全部一致；仅新增账号和相关状态表。证据：升级前（原始附件已转存私有验收资料）、升级后（原始附件已转存私有验收资料）、对比结果（原始附件已转存私有验收资料）。

## 正式环境验收

- 本机至 `192.0.2.10:3002` 的健康接口可达，容器状态 `healthy`。
- 原登录配置成功登录管理员，未登录读取曲库返回 401。
- HTML、带哈希的 JS/CSS、缓存响应头和新版 favicon 可用。
- 曲库、分页、12 张专辑、专辑详情、2 个歌单及目录可读状态通过真实 API 验证。
- 真实 NAS 封面读取成功。
- 对 FLAC 显式使用 `mode=direct` 验证 206 Range，响应前 65,536 字节与只读源文件严格一致；默认 FLAC 仍沿用现有转码策略。
- 转码接口从 60 秒位置输出 MP3，输出片段再次经过 FFmpeg 解码验证。
- 浏览器使用现有管理员凭据完成登录，新版首页显示 1,045 首歌曲、12 张专辑和原有歌单；浏览器控制台与容器日志检查无警告/错误。

接口验收输出见 smoke.json（原始附件已转存私有验收资料）。正式页面截图：

原始截图已转存私有验收资料。

## 构建与依赖

部署构建时发现既有依赖安全公告，升级至 Fastify `5.12.5`、`@fastify/static` `10.1.5` 并更新兼容的间接依赖。静态插件新版的 `setHeaders` 使用 `FastifyReply`，相应切换为 `reply.header()`，生产 HTML 不缓存、带哈希资源长期缓存的行为保持不变。相关路径校验公告见 [GHSA-8pvw-jcv7-9cmj](https://github.com/advisories/GHSA-8pvw-jcv7-9cmj)。

更新后重新验证：

- `npm run typecheck`：通过。
- `npm test`：28 个文件、430 项测试通过。
- `npm run build`：通过，正式前端资源仍为 `index-DDdBU7C7.css` / `index-C5uX5jgS.js`。
- `git diff --check`：通过。
- `npm audit --omit=dev`：0 项漏洞；Docker 最终运行层仅安装生产依赖。
- 全依赖审计剩余 1 项低级别开发依赖公告（Vite 所用 esbuild 的 Windows 开发服务器问题，[公告](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr)），不包含在 Linux 生产运行层。
- 独立 Linux 镜像启动、SQLite 原生模块、登录和静态响应检查通过。

## 回退与后续维护

多账号升级涉及数据库迁移。若需回退，应先停服，保留当前 `data-nas`，将上述备份恢复到一个全新目录，再让旧镜像使用恢复后的目录；不要直接让旧程序继续写入新版数据库。恢复时保持容器音乐路径 `/music` 和数据路径 `/data`，避免缓存路径改变。

管理员密码以后在“我的账号 → 登录与安全”修改。`ADMIN_PASSWORD` 只负责首次创建管理员，修改 `.env` 不再重置已有账号密码；不要照旧版部署记录用重建容器的方式改密码。

本次已验证真实 NAS 文件读取和转码，未做实体手机后台/锁屏、长时间播放或主机重启验收。
