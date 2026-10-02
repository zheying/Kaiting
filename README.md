# 开听 · NAS Music Library

开听是面向个人 NAS 的音乐库与网页播放器，使用 React/Vite、TypeScript、Fastify 和 SQLite。管理员与普通账号共享曲库，各自保存收藏、歌单和播放偏好。

**音乐目录始终只读。** 扫描与信息补全不改标签、不移动或重命名文件；索引、账号、会话、收藏、歌单、封面及元数据缓存保存在 `DATA_DIR`。

## 已实现的功能

- 音乐室首页、专辑、艺人、歌曲、搜索、收藏、私人歌单、账号与管理员页面；正式界面以独立设计原型为基准。
- 桌面、平板与手机布局，动态登录背景、胶囊播放器、全屏播放、同步歌词、待播队列及加载/空/错误状态。
- 音乐驱动的舞台氛围模式，22 种灯光、自动编排、鼓点响应及浮动歌词/待播清单，与普通模式连续播放。
- 只读增量扫描，读取本地标签、内嵌或目录封面、`.lrc` 歌词；目录选择后自动扫描，支持进度、错误详情、中断恢复和受保护的缺失索引清理。
- MP3、M4A/AAC、FLAC、ALAC、OGG、OPUS、WAV；兼容格式直传，FLAC、ALAC 等按需转码。
- SQLite 全文搜索、分页读取与多碟专辑展示；歌单创建、重命名、添加/移除、拖动排序及并发冲突处理。
- 专辑年份与流派的人工补充、在线发行版查找，以及扫描后高置信结果自动保存；保留来源与人工管理保护。
- 数据备份、校验与恢复，以及缺失封面的离线缓存导入。部署支持 Docker Compose 或本地 Node.js。

## Docker 快速启动

准备 Docker Compose 和已挂载的音乐目录，在仓库根目录执行：

```bash
cp .env.example .env
openssl rand -hex 32
```

编辑 `.env`：填写初始管理员密码 `ADMIN_PASSWORD`，将生成的随机字符串填入 `COOKIE_SECRET`，设置真实的主机 `MUSIC_LIBRARY_PATH` 和持久化 `DATA_DIR`。若在可信局域网直接使用 HTTP，设 `COOKIE_SECURE=false`；HTTPS 反向代理保持 `true`。

```bash
docker compose up -d --build
docker compose ps
```

打开 `http://主机地址:3000`（或 `.env` 中的 `PORT`），用 `admin` 和配置的初始密码登录，在“设置 → 音乐目录”选择目录。首次选择及以后更换目录都会自动扫描。已有账号使用数据库内的密码，修改 `ADMIN_PASSWORD` 不会重置它。

Compose 自动读取 `.env`，将主机音乐目录只读挂载到 `/music`，将主机 `DATA_DIR` 挂载到 `/data`，将主机 `PORT` 转发到容器固定端口 `3000`。配置改变后重新执行 `docker compose up -d`；代码更新后使用 `docker compose up -d --build`。

容器配置了 `unless-stopped`、进程回收、健康检查，以及最多 3 个 10 MB 的日志文件。健康检查失败本身不会触发自动重启；异常退出才按重启策略恢复。主机需保持 Docker 运行，并避免自动睡眠。

### 使用另一台 NAS 的 NFS 目录

[docker-compose.nfs.yml](docker-compose.nfs.yml) 可将 `/music` 替换为只读 NFS Docker 卷，`/data` 仍放在应用主机磁盘上。先创建 NFS 卷，在 `.env` 设置 `NAS_MUSIC_VOLUME`；基础配置插值仍要求 `MUSIC_LIBRARY_PATH` 非空。

```bash
docker compose -f docker-compose.yml -f docker-compose.nfs.yml up -d --build
```

也可在部署目录中把该文件复制为 `docker-compose.override.yml` 自动加载。卷创建、路径映射和维护步骤见 [Docker/NFS 部署指南](docs/docker-deployment.md)。示例使用占位地址和路径；真实部署配置保留在仓库外。

## 环境配置

以 [.env.example](.env.example) 和 [服务端配置](src/server/config.ts) 为准。以下默认值指未设置相应变量时；开发脚本的端口固定为前端 `3000`、API `3001`。

| 变量 | 用途与默认值 |
| --- | --- |
| `ADMIN_PASSWORD` | 初始管理员 `admin` 的密码；生产必填，开发默认 `admin`。仅首次初始化账号时使用 |
| `COOKIE_SECRET` | Cookie/会话密钥；生产必须是至少 32 字符的私有随机值，公开示例密钥会被拒绝 |
| `COOKIE_SECURE` | 生产默认 `true`，开发默认 `false`。可信局域网 HTTP 直连须设为 `false`；HTTPS 保持 `true` |
| `PUBLIC_ORIGIN` | 可选，音乐室页面的完整 HTTPS 来源，例如 `https://music.example.com`；与 `DIRECT_MEDIA_ORIGIN` 配套 |
| `DIRECT_MEDIA_ORIGIN` | 可选，直接访问 NAS 的 HTTPS 来源，例如 `https://direct.music.example.com:5443`；留空关闭媒体直连 |
| `MUSIC_LIBRARY_PATH` | 本地默认 `./music`；Compose 中必须填写主机曲库路径，容器内为 `/music` |
| `MUSIC_LIBRARY_ROOTS` | 可选的额外允许根目录；macOS/Linux 用冒号分隔，Windows 用分号分隔。默认只允许主曲库及其子目录 |
| `DATA_DIR` | 默认 `./data`。本地为数据目录；Compose 中为主机持久化路径，容器内为 `/data` |
| `ENABLE_ONLINE_METADATA` | 在线能力总开关，默认 `false`；关闭时不发送在线补全请求 |
| `SCAN_ONLINE_METADATA` | 默认 `true`；总开关开启后，允许扫描期间逐曲查找缺失标签、封面和歌词 |
| `AUTO_COMPLETE_ALBUM_METADATA` | 默认 `true`；总开关开启后，扫描完成时在后台补齐专辑年份和流派，可显式关闭 |
| `PORT` | 本地服务或 Compose 主机发布端口，默认 `3000`；容器内部固定 `3000` |
| `MUSIC_LIBRARY_IMAGE` | Compose 镜像标签，默认 `music-library:local` |

`MUSIC_LIBRARY_ROOTS` 在 Docker 中须使用容器内路径，并自行添加对应的只读卷和环境变量映射；仅在 `.env` 中填写主机路径不能访问未挂载的目录。

`COOKIE_SECURE` 只控制 Cookie，不会为服务启用 HTTPS。外网访问应使用 HTTPS 或 VPN。保存好随机密钥；更换 `COOKIE_SECRET` 会使已有登录会话失效。

### NAS 媒体直连

页面通过公网服务器反向代理到 NAS 时，可以另外提供直达 NAS 的 HTTPS 入口。配置上面两个来源（仅协议、域名及可选端口，不含路径），浏览器登录后自动检测同一音乐室，获取独立的只读媒体凭证。音频和页面封面优先直连，页面、账号、歌单等 API 继续使用页面入口；系统播放通知封面和全屏背景仍使用有尺寸上限的页面入口图片。探测成功不会重载正在播放的音频；直连音频失败或持续等待时，自动使用公网入口从当前进度重试一次。

直连域名须有浏览器信任的证书，并与页面使用相同主域名及 HTTPS，以便发送 `SameSite=Strict` 的媒体 Cookie。例如 `music.example.com` 与 `direct.music.example.com`。反向代理须保留含端口的 `Host`（Nginx 使用 `proxy_set_header Host $http_host;`），转发 `Origin`、`Range`、`If-Range`，关闭媒体缓冲。直连虚拟主机只需转发 `/api/media/probe`、`/api/media/connect`、`/api/media/status`、`/api/tracks/:id/stream` 和 `/api/tracks/:id/artwork`；可另开放 `/api/health` 用于运维检查。不要把私钥、主登录 Cookie 或票据放进 URL，也不要添加通配 CORS。

入口可以解析到固定内网地址，或以 DNS-only CNAME 跟随家庭 DDNS。前者需网络允许 DNS 返回私有地址；后者可以绕过公网服务器，但在家访问时是否完全留在局域网取决于路由器的 NAT 回环。浏览器权限、DNS 过滤、证书或网络不可达都会使探测回退，不影响原入口播放。设置里的“优先 NAS 直连”偏好仅保存在当前浏览器，可关闭或手动重新检测；提示“NAS 直连可用”表示后续请求可使用该入口，不表示已验证物理网络路径。

媒体凭证有效期 15 分钟，页面后台提前刷新；普通登录会话退出、被撤销、改密或账号停用后，凭证不能再发起读取。已发送或缓冲到客户端的数据不能撤回。证书续期应通过 ACME 安装钩子复制到代理使用的位置，并在配置检查通过后重载。

## 本地运行与设计原型

本地需要 Node.js 22（至少 22.12）或 24，以及可执行的 FFmpeg。Docker 镜像已包含 FFmpeg。以下命令按 macOS/Linux shell 书写。

### 开发正式系统

```bash
npm ci
MUSIC_LIBRARY_PATH="/实际音乐目录" DATA_DIR="./data/development" npm run dev
```

打开 `http://localhost:3000`。Vite 代理 `/api` 到 `3001`；开发 API 端口本身不托管前端。未配置初始密码且数据库为空时，账号是 `admin` / `admin`。

开发脚本和 `npm start` **不会自动加载 `.env`**。开发时通过进程环境传入配置；建议使用独立的 `DATA_DIR`，不要与运行中的生产服务共享。

### 本地生产启动

复制并编辑 `.env`，填写密码、密钥和本机路径，然后：

```bash
npm ci
npm run build
NODE_ENV=production node --env-file=.env dist/server/server/index.js
```

生产模式由 Fastify 托管 `dist/client`。本地 HTTP 访问同样需要 `COOKIE_SECURE=false`。`npm start` 适用于配置已注入进程环境的情况。

### 独立设计原型

```bash
npm run prototype
```

原型入口为 `http://127.0.0.1:4173/#/home`，状态总览为 `http://127.0.0.1:4173/#/preview`。原型使用模拟数据，供设计和交互对照；正式系统通过真实 API、数据库和音频运行。修改原型不会自动更新正式界面。

原型单独构建和预览使用 `npm run prototype:build`、`npm run prototype:preview`。详见 [原型说明](prototypes/listening-room/README.md)。

## 音乐目录与扫描

管理员在“设置 → 音乐目录”选择服务器允许访问的目录，首次选择和更换目录都会自动扫描并呈现结果。普通账号不能维护目录。切换目录时停止播放、清空队列并更新列表；原目录的索引、收藏和歌单成员保留，当前界面仅显示所选曲库。

日常“重新扫描”采用增量方式：处理新增文件、音频属性变化、本地封面/歌词变化及缓存失效，跳过已处理且未变化的文件。首次扫描或解析规则升级导致缓存失效时需要重新读取；解析失败的文件下次仍会重试。扫描结果包含已检查、重新解析、跳过和错误数，错误详情保留文件路径及原因。

扫描进度页可停止任务，已读取内容保留。服务异常退出后，下次启动把遗留任务标记为失败并保留进度；再次扫描时跳过已完成且未变化的文件。常规服务启动不会自动发起长时间扫描。

管理员 API `POST /api/scan` 支持以下请求，其中 `force` 和 `prune` 不放在日常设置页：

| 请求 | 行为 |
| --- | --- |
| 省略请求体或 `{}` | 默认增量扫描，保留暂时失踪的索引 |
| `{ "force": true }` | 重新解析全部音频元数据；启用扫描期间在线补全时也重试相关查询，保留收藏和歌单 |
| `{ "prune": true }` | 扫描后清理失踪索引及其收藏、歌单关联，仍不修改音乐文件 |

`prune` 只在非空、完整、无错误且通过挂载检查的扫描后执行。空库、权限/解析错误、挂载身份变化或原有目录整段消失均会阻止清理。它不能用来自动迁移曲库挂载路径；执行前应确认 NAS 与子目录已完整挂载。

## 专辑信息与在线补全

管理员从专辑详情页的“编辑专辑信息”进入，填写四位发行年份和最长 80 字的流派。专辑卡片仅展示信息，不提供编辑入口。信息按曲库与专辑保存在数据库中，对所有成员可见，重新扫描不会覆盖人工设置；留空沿用扫描值。点击“恢复扫描信息”后还需保存才生效。并发编辑产生版本冲突时会要求重新载入。

后台自动补全与人工修正各自独立：

| 方式 | 触发与保存 |
| --- | --- |
| 人工修正 | 手动填写或选用“发行参考”的年份与流派，点击“保存信息”后生效；参考查询失败或在线能力关闭时仍可手动编辑 |
| 扫描后后台补全 | 初次扫描、新增专辑后的增量扫描及重新扫描，只要完整且无文件错误、无遗留缺失索引，随后串行查询；可信字段直接保存，无需打开页面、确认或点击保存。启动时也检查符合条件的已扫描曲库 |

开启在线能力后，后台专辑补全默认启用。建议让本地扫描先完成，再在后台补齐专辑信息：

```dotenv
ENABLE_ONLINE_METADATA=true
SCAN_ONLINE_METADATA=false
AUTO_COMPLETE_ALBUM_METADATA=true
```

这样扫描只读取本地信息，后台查询随后独立执行。若还需要扫描期间逐曲查找缺失标签、封面与歌词，将 `SCAN_ONLINE_METADATA` 设为 `true`；这会让扫描等待网络查询。在线提供方包括 MusicBrainz、Cover Art Archive 和 LRCLIB，断网时仍可使用本地标签。

专辑查找只向 MusicBrainz 发送专辑名称和候选发行 ID，不上传本地曲目、音频、路径或账号信息。自动判断先核对专辑名称（保留版本字样）、艺人、曲目数和已有年份。合辑通用署名或数字版、实体版的分碟不同，须额外在本地核对完整曲目名称及逐曲时长；具体艺人冲突、曲目数量不同或曲目内容不符时跳过。

曲名可使用 MusicBrainz 明确关联的发行曲名与 recording 原文曲名，处理同一录音的语言差异；发行方的版本前后缀仍保留。本地统一前缀只有能由专辑名称解释时才视为冗余，不任意剥离 Live、Remastered 等字样；逐曲时长最多允许 3 秒差异，重复曲名也必须逐一对应。

确认候选对应同一音乐内容后，年份和流派分别判断：多个正式版本的已知值一致即可补齐该字段，有冲突的字段保持空白，不按多数票猜填。候选缺少某字段不视为冲突；只采用其他可靠候选明确提供的共识值。每次最多检查 100 条搜索结果和 12 个同名发行详情，详情查询失败、搜索截断或超过预算时均不自动保存。年份与流派分别记录支持来源；仅收录 Soundtrack 分类时显示“原声”。

展示优先级为 **人工设置 → 扫描标签 → 自动结果**。管理员保存信息（包括恢复扫描信息）后，该专辑转为人工管理，后续后台任务不再修改，需要调整时继续从编辑入口修正。后台保存后已打开的曲库自动更新，弹窗可查看来源。

开启在线能力后，编辑弹窗会自动读取“发行参考”，复用同一查询缓存，展示日期、地区、格式、曲目数、流派、艺人及 MusicBrainz 来源。曲目数、分碟或艺人等差异会明确标注；较多候选可展开查看，结果截断或详情不完整会提示。点击“采用此版本”只将候选已提供的年份和流派填入草稿，缺失字段保留原输入，取消不会保存。查询晚到不改写表单；目录、曲库版本或人工信息变化使查询失效时保留草稿，需明确重新载入。这与扫描后无人干预的后台补全相互独立。

MusicBrainz 请求共用至少 1.1 秒的间隔，并限制并发、超时和响应大小。专辑查询成功缓存一天，无结果缓存十分钟，连接错误不缓存；缓存也包含本地曲目名称与时长证据，更换同数量歌曲不会复用旧判断。后台连续失败时暂停，最多在 1 分钟、5 分钟后各重试一次；以后完整扫描或服务重启仍可重新检查。

在线文件缓存位于 `DATA_DIR/metadata`、`DATA_DIR/artwork`；专辑查询缓存、补充信息、自动来源和人工管理标记保存在 SQLite 中，均随数据备份保留。

## 浏览、播放与歌单

歌曲列表先显示 40 首，“载入更多”继续显示；“播放全部”使用当前视图完整的匹配集合，不受已显示条数限制。点击单曲从该曲开始播放所属列表。搜索使用 `#/search?q=关键词`，兼容旧的 `#/search/关键词`。

客户端通过分页 API 读取一致的曲库元数据快照，在内存中完成筛选、搜索预览、歌单封面拼接和队列操作；音频与封面按需加载。大型曲库仍需按实际规模评估首屏耗时和浏览器内存。

封面根据实际显示尺寸与屏幕像素密度选择 64、128、256、512、1024 或 1600px 版本；列表、胶囊播放器及歌单拼图不下载原图，模糊背景固定使用 128px，锁屏封面使用 512px。服务端通过 Sharp 按需生成保留比例的 WebP，不放大小源图；缓存写入 `DATA_DIR/artwork/thumbnails`，同源同尺寸复用，并限制转换并发、输入大小和像素数。图片响应使用私有缓存与 ETag，封面文件变化后重新生成，源曲库保持只读。Sharp 随 `npm ci` 安装，无需单独安装图像命令行工具。

多碟专辑按碟展示并连续播放。缺少专辑艺人标签时，仅在专辑名的 `[Disc N]` / `[CD N]` / `[Bonus Disc]` 后缀、碟目录和上一级专辑目录一致时合并发行版。原标签、歌曲 ID、收藏和歌单不变，旧单碟链接仍可访问；其他情况保守维持原分组。

### 舞台氛围模式

在全屏播放页点击右上角的星光图标进入。氛围模式与普通播放页、胶囊共用音源、队列、音量、收藏和循环状态，进出模式不会重新加载歌曲。歌词使用正式歌词服务与完整音频时钟，包含转码跳转的时间偏移。

默认“跟随音乐”，也可选择 22 种灯光编排，以及轻柔/鲜明强度、琥珀/暗红/深蓝色调。灯具位置固定，光束随声音变化；歌词与待播清单浮于舞台之上，开关时不挤压画面。灯光、选曲与画面设置浮窗支持外侧关闭和 Esc 分层关闭。浏览器支持时可进入全屏，闲置时自动隐藏控制。

实时声音分析在播放会话内运行，音量通过分析后的增益控制，因此静音仍能观察节奏。进入氛围模式后，服务端用 FFmpeg 只读提取曲目的声音特征，异步生成编排；音乐不等待分析。分析最多并行两首，单任务限时 60 秒、录音分析范围为 45 分钟；不支持、超时或繁忙时使用实时灯光。WebGL 不可用时提供简化画面，并遵循减少动态效果偏好。

编排缓存保存在 `DATA_DIR/lighting`，最多保留 256 份；源文件或编排版本改变时重建。缓存是可重新生成的派生数据，不纳入现有备份包。不会上传音频或改写曲库。声音分析不支持时保留原生播放；浏览器拒绝恢复已接入的声音输出时显示播放授权重试。

### 播放兼容性

| 格式/操作 | 策略 |
| --- | --- |
| 浏览器兼容的 MP3、AAC M4A、OGG、OPUS、WAV | 优先直传原文件 |
| FLAC、ALAC（含 ALAC M4A）及不兼容格式 | 按 `shouldTranscode(track)` 通过 FFmpeg 输出 MP3 流 |
| 显式请求 `mode=transcode` | 强制转码；流接口同时支持 `auto`、`direct` |

播放器支持进度拖动、音量/静音、随机播放、顺序播放、单曲与列表循环。移动端保留胶囊外形、全屏封面缩放、歌词及待播清单。iPad 使用桌面/平板布局。

开启 `ENABLE_ONLINE_METADATA` 后，打开歌词面板时会优先读取本地歌词，缺失时自动向 LRCLIB 查询，不依赖 `SCAN_ONLINE_METADATA`。匹配会核对曲名、艺人及可用的专辑和时长信息，歌词仅缓存在 `DATA_DIR`。无匹配结果缓存 24 小时；“重新查找歌词”会刷新查询，仍遵守提供方的限流。网络失败显示可重试状态，不会保存为“没有歌词”。

在线歌词包含有效的 Lyricsfile 逐词时间时，播放器根据音频时钟高亮对应词段，保留停顿与长短差异；仅有逐句 LRC 时使用整句高亮和自动滚动，不推算逐字进度。未提供词结束时间时仅在其起点高亮。旧在线缓存会在打开歌词时按需升级，查询失败仍可使用原歌词；本地音乐文件保持只读。`GET /api/tracks/:id/lyrics?format=json` 返回结构化时间轴，不传 `format` 时保留文本响应。

### 整理歌单

从歌曲“更多”菜单添加到已有歌单或新建歌单。详情页支持重命名、移除和删除；“调整顺序”可拖动手柄，支持触摸与键盘：空格选中，方向键或 Home/End 移动，空格放下，Esc 撤销。点击“保存顺序”提交，取消则放弃草稿。

并发修改会提示冲突；失败保留可重试入口。编辑与删除歌单不会重写当前播放队列，新顺序在下次播放歌单时生效。删除歌单需要确认，仅删除歌单及关联，不删除音频或收藏。

## 账号与权限

首次启动创建管理员 `admin`。升级旧数据时保留曲库，并将既有收藏与歌单归入该账号；旧登录会话需重新登录。播放与界面偏好按账号保存到数据库，不导入旧浏览器的本地播放设置。

管理员在“我的账号 → 用户管理”创建普通账号或管理员。创建时由服务端生成 12–22 位随机临时密码，只在本次响应中返回；新账号首次登录和密码重置后必须设置自己的密码。

普通账号不能扫描、选择目录、补充共享专辑信息或管理用户。管理员同样不能读取其他账号的私人收藏与歌单。账号停用或角色变化会撤销该账号的会话；系统禁止停用/降级自己，并保留至少一位可用管理员。

用户名不区分大小写，密码使用带盐 scrypt 存储；临时密码不存明文。Cookie 为 HttpOnly、SameSite=Lax，服务端会话可撤销。普通改密会退出全部会话，首次改密保留当前会话。

## 数据维护与升级

同一 `DATA_DIR` 只允许一个服务或维护进程使用，由 `.runtime-lock.sqlite` 保持独占。以下维护命令先构建并停止当前音乐服务，再使用相同路径配置运行。

### 备份

```bash
npm run build
node --env-file=.env dist/server/server/maintenance.js backup
```

也可显式传参：

```bash
npm run data:backup -- --data-dir ./data --music-library-path "/实际音乐目录"
```

默认输出 `DATA_DIR/backups/backup-时间-标识/`，包括含已提交 WAL 数据的 SQLite 快照、`artwork`、`metadata`、文件清单及 SHA-256。账号、密码哈希、会话、偏好、收藏、歌单、扫描记录和补全信息随数据库保存；不复制音频、`.env` 或旧备份。

可用 `--backup-root` 指定其他备份父目录，但不能放进曲库或正在备份的缓存目录。运行中的服务会阻止备份，保证数据库与缓存一致。完成的备份应另存一份，随机密钥和部署配置也需单独保存。

### 恢复与升级

恢复必须使用新目录或空目录：

```bash
node --env-file=.env dist/server/server/maintenance.js restore \
  --backup "./data/backups/实际备份目录" \
  --data-dir "./data-restored"
```

恢复验证所有文件与 SQLite 完整性，并重定位旧 `DATA_DIR` 的缓存引用。音乐路径和歌曲 ID 保持原样，曲库须挂载在原路径；本机目录与 Docker `/music` 之间的路径迁移不在此工具范围内。

完成后修改 `.env` 的 `DATA_DIR`，按原方式启动，检查收藏、歌单、歌词与播放。若恢复中断，未完成目录保留标记并拒绝启动；换新目录重试，不要删标记强行启动。

升级前先停止服务、备份数据，再构建并启动新版。数据库迁移保留既有数据；回退旧版应使用升级前备份。维护脚本不会自动加载 `.env`，可用上述 `node --env-file` 方式或显式参数；容器中须沿用服务路径映射并停止原服务。

### 导入缺失封面

音频和目录均无封面时，可补齐应用缓存：

```bash
npm run data:import-artwork -- \
  --data-dir ./data \
  --album-key '专辑 API 返回的 key' \
  --file /绝对路径/cover.jpg \
  --source-url '封面来源网址'
```

该命令也要求停止服务，只更新缺失封面并记录来源，不改音频或已有封面。重扫保留有效缓存，新发现的内嵌/目录封面优先。容器执行时沿用 `/data`，将导入图片另行只读挂载。各维护命令可追加 `--help` 查看参数。

## 代码结构

| 路径 | 用途 |
| --- | --- |
| `src/client/App.tsx`、`src/client/main.tsx` | 正式会话、登录和客户端入口 |
| `src/client/room/` | 正式页面、播放器、账号、专辑信息表单及样式 |
| `src/client/api.ts` | 客户端 API 契约 |
| `src/server/` | 认证、API、SQLite、扫描、媒体、在线补全及维护工具 |
| `src/shared/` | 共享类型和账号契约 |
| `prototypes/listening-room/` | 独立设计原型 |
| `tests/`、`e2e/`、`scripts/` | 单元/集成测试、浏览器验收、选择与 CI 脚本 |
| `dist/`、`data/`、`artifacts/` | 构建输出、默认运行数据、验证产物；不提交版本库 |

## API 速览

主要定义在 [routes.ts](src/server/routes.ts) 和 [account-routes.ts](src/server/account-routes.ts)。除健康检查与登录等入口外需要登录；管理接口由服务端检查权限，个人数据按当前账号隔离。

| 范围 | 主要接口 |
| --- | --- |
| 健康与会话 | `GET /api/health`；`POST /api/auth/login`、`/api/auth/logout`；`GET /api/me` |
| 我的账号 | `PATCH /api/account/profile`、`/api/account/preferences`；`POST /api/auth/password`；`GET` / `DELETE /api/account/sessions` |
| 用户管理 | `GET` / `POST /api/admin/users`；`PATCH /api/admin/users/:id`；`POST /api/admin/users/:id/password` |
| 目录与扫描 | `GET` / `PUT /api/directories`；`GET` / `POST /api/scan`；`POST /api/scan/stop`；`GET /api/scan/errors` |
| 曲库状态 | `GET /api/summary`、`/api/catalog/status`、`/api/metadata/status` |
| 浏览与搜索 | `GET /api/tracks`、`/api/albums`、`/api/artists`、`/api/search`；详情为 `/api/tracks/:id`、`/api/albums/:key`、`/api/artists/:name` |
| 音轨与媒体 | `PATCH /api/tracks/:id/favorite`；`GET /api/tracks/:id/artwork`、`/api/tracks/:id/lyrics`、`/api/tracks/:id/stream`、`/api/tracks/:id/availability` |
| 灯光编排 | `GET /api/tracks/:id/lighting`，需登录，返回 `{ program }`，不接受查询参数 |
| 专辑补充信息 | `GET` / `PUT /api/admin/albums/:key/metadata`；`POST /api/admin/albums/:key/metadata/lookup` |
| 歌单 | `GET` / `POST /api/playlists`；`GET` / `PATCH` / `DELETE /api/playlists/:id` |
| 歌单成员与顺序 | `POST /api/playlists/:id/tracks`；`DELETE /api/playlists/:id/tracks/:trackId`；`PUT /api/playlists/:id/tracks/order` |

主要契约：

- 歌曲、专辑、艺人列表支持 `q`、`limit`、`offset`；添加 `page=true` 返回 `{ items, total, limit, offset, revision }`，省略时返回数组。`limit` 为 1–500，`offset` 为非负整数；默认歌曲 80 项，专辑/艺人 200 项。歌曲另支持 `favorite`。
- 搜索预览最多返回 25 首歌曲、12 张专辑和 12 位艺人；完整匹配集合使用相应列表接口。分页 `revision` 用于检测跨页数据变化。
- 封面接口可带 `?size=64`（仅允许上述六档），返回 WebP；不带尺寸时保留原图接口。所有版本均需登录，支持 `If-None-Match` / `304`，不公开缓存私有曲库图片。
- 专辑保存提交 `{ year, genre, revision }`，`null` 表示沿用扫描值，版本冲突返回 `409`。查找提交 `{ revision }`，返回候选、推荐 ID、部分失败/截断标记；只缓存查询，不直接写人工覆盖值。
- 歌单创建支持 `requestId` 安全重试。排序提交 `{ trackIds, revision }`，必须是当前完整成员的无重复排列；版本冲突返回 `409`，不写入部分顺序。重复添加不重复歌曲，重复移除可安全重试。
- 歌单详情及成员修改返回 `{ playlist, tracks, revision }`；名称去除首尾空白后为 1–200 字符。不存在的歌单返回 `404`，非法参数返回 `400`。
- 扫描状态含 `scannedFiles`、`parsedFiles`、`skippedFiles`、`errorCount` 和 `force` / `prune`；读取状态不会启动扫描。`/api/catalog/status` 提供曲库版本及后台补全进度，不暴露目录路径或账号信息。

## 开发验证

遵循 [AGENTS.md](AGENTS.md#测试与交付)：根据本次行为变化及风险选择最小充分验证集，先说明范围与依据。复杂交互与跨层流程优先做针对性 E2E；局部修改优先精确到用例或文件，不默认运行整个相关模块。原型或旧实现通过不能代替正式系统验收。

代码交付的基础检查：

```bash
npm run typecheck
npm run build
git diff --check
```

仅文档修改核对链接、路径、命令和配置，不默认构建或执行产品测试。纯样式修改以相关页面、状态和视口检查及截图为主，不默认运行 E2E。连续小调整合并验证；已有结果覆盖最终改动时复用，E2E 内已完成的同一源码生产构建不重复执行。出现具体风险、相关失败或新增影响面时才扩大范围；所选验证充分且通过后停止。

### 按改动选择范围

```bash
npm run test:list
npm run test:scope -- playback --list
npm run test:scope -- playback
npm test -- tests/seek-input.test.ts
npm run test:scope -- playlists -t 'conflict|revision'
npm run test:e2e -- playback --list
npm run test:e2e -- playback
npm run test:e2e -- playlists -g '重试'
```

`--list` 仅预览，不执行测试；E2E 预览也不构建或启动服务。可传多个功能取并集，或精确的 `tests/*.test.ts` / `e2e/*.spec.ts` 文件。裸 `npm test` 和 `test:e2e` 会拒绝执行。

| 改动范围 | `test:scope`（单元/集成） | `test:e2e`（浏览器流程） |
| --- | --- | --- |
| 认证、账号 | `auth` | `auth` |
| 目录与扫描 | `scan` | `library-scan` |
| 播放 | `playback` | `playback` |
| 氛围灯光 | `atmosphere` | `atmosphere` |
| 歌单 | `playlists` | `playlists` |
| 曲库、搜索 | `catalog` | `catalog` |
| 元数据补全 | `metadata` | `album-metadata`、`album-metadata-candidates` |
| 封面加载 | 精确选择 `tests/artwork.test.ts` | `artwork` |
| 移动布局与页面逻辑 | `ui` | `mobile-player`，其他页面选择所属功能 |
| 备份与维护 | `maintenance` | `maintenance` |
| 路径安全 | `paths` | 按相关扫描/播放/维护流程选择，并保留路径边界测试 |

`test:unit`、`test:integration` 按层级运行；`test:prototype` 仅选择独立原型，`test:scope -- legacy` 选择保留的旧实现。原型与 legacy 均保留在显式全量中，生产功能范围不隐式包含它们。新增或移动 `.test.ts` 须登记 [test-catalog.mjs](scripts/test-catalog.mjs)，新增 E2E spec 自动进入显式全量范围。

### E2E 环境与证据

E2E 使用生产构建、临时曲库和独立 SQLite，默认每次先构建；需要 FFmpeg 和 Playwright 管理的独立测试浏览器。使用 `chromium` 通道，当前锁定版本为 Chrome for Testing；不启动系统 Google Chrome，也不读取个人浏览器资料。首次安装及更新 Playwright 后执行：

```bash
npx playwright install chromium --no-shell
# Linux CI 同时安装系统依赖：
npx playwright install --with-deps chromium --no-shell
```

运行前统一检查浏览器启动与 AAC 解码能力；检查失败即停止，不让每个用例重复启动。测试保持零重试，首个用例失败后停止后续用例。旧的 `E2E_BROWSER_CHANNEL=chrome` 配置会明确报错，应移除；不会自动回退到系统浏览器。macOS 的受限 seatbelt 执行环境会在启动前被拦截，应从普通终端或获准的执行环境运行同一命令，不要清除环境标志重试。

排查无硬件加速环境中的氛围画面时，可用 `E2E_SOFTWARE_RENDERING=1 npm run test:e2e -- atmosphere` 在同一独立浏览器中启用 SwiftShader。先加 `--list` 核对范围；该选项不改变用例、断言、超时或重试规则。氛围画面对软件渲染和 Canvas 降级画面限制灯光分辨率，硬件 WebGL 保留原有分辨率预算。浏览器用例使用单 worker 顺序执行，避免多个软件渲染页面争用 CPU，干扰真实音频和重拍时序测量。

AAC 直传及 ALAC/FLAC 转码仍以实际播放验收；手机/iPad 为 Chrome 设备模拟，不能替代真实 iOS Safari 验收。`npm run test:browser` 单独检查启动保护与失败处理，不启动真实浏览器，报告位于 `artifacts/browser-isolation/`。

每次生成 `artifacts/e2e/<时间>-<范围>/`，包含 HTML/JSON/JUnit 报告、逐例 trace/截图、网络与服务日志、音乐哈希和 SQLite 校验。`browser-preflight.json` 记录启动检查、浏览器版本、WebGL 渲染器和失败原因，`run.json` 记录命令、Git HEAD 与源码/构建 SHA-256，可核对未提交工作区。预检失败时不会生成逐例截图或启动业务服务。查看方式：

```bash
npx playwright show-report "artifacts/e2e/实际运行目录/html"
npx playwright show-trace "/实际产物路径/trace.zip"
```

`npm run test:inventory` 仅收集用例，写入 `artifacts/tests/inventory.json`、`artifacts/tests/e2e-inventory.json`，不执行测试或启动浏览器；清单数量不代表通过数量。`npm run test:selection` 单独验收测试选择命令，产物在 `artifacts/test-selection/`。

### 显式全量与 CI

仅在用户明确要求本次完整回归、适用的 CI/发布门禁明确要求，或有证据表明跨模块影响无法可靠界定时运行。执行前说明依据；每次交付、提交或部署不自动触发全量。保留既有 CI 门禁。

```bash
npm run test:all             # 全部 unit/integration，含原型与兼容路径
npm run test:e2e:all         # 全部浏览器 E2E
npm run test:ci -- --list    # 只预览 CI 阶段
npm run test:ci             # 类型、构建、选择命令、全部层级及 diff 检查
```

[CI 工作流](.github/workflows/tests.yml) 使用 Node 22、FFmpeg 和独立 Chrome for Testing，与本地共用启动及 AAC 预检，包含启动保护验收，禁止 `.only`，不接受筛选缩减，并上传 `artifacts/`。`test:ci:node` 只是 unit/integration 全量步骤，不能单独代表完整 CI。`E2E_SKIP_BUILD=1` 仅用于已构建的调试或 CI 阶段。

## 相关文档

- [AGENTS.md](AGENTS.md)：协作与实现约束；[CLAUDE.md](CLAUDE.md) 指向同一份规范。
- [工程化落地记录](docs/engineering-rollout.md)与[设计验收记录](design-qa.md)：原型到正式系统的实现背景。
- [测试整改记录](docs/testing/test-implementation-2026-09-28.md)、[原始审查](docs/testing/test-audit-2026-09-28.md)、[E2E 验收计划](docs/testing/e2e-acceptance-plan.md)、[选择命令验收计划](docs/testing/selector-acceptance-plan.md)：范围、失败模式与验证证据。
- [Docker/NFS 部署指南](docs/docker-deployment.md)：通用部署与维护步骤，不包含实际主机或账号信息。

仓库中的历史验收说明已经脱敏。截图、日志、trace、数据库检查结果和原始部署记录保存在被忽略的 `artifacts/` 或仓库外私有目录；`docs/` 仅提交脱敏的 Markdown 说明。分享报告或提交前，应检查内网地址、个人路径、SSH 账号、Cookie 与凭据。
