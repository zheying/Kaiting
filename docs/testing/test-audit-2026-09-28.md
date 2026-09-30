# 测试体系审查 · 2026-09-28

> 隐私说明：环境地址和路径已替换为示例；原始验收附件在仓库外私有保存，不随仓库发布。

> 这是只读审查阶段的历史快照。用户后续要求落实建议，最新数量、命令和逐项处置见[测试整改结果](test-implementation-2026-09-28.md)。

目标是减少日常无关执行，不以减少测试数量为指标。本次没有删除、禁用、迁移或修改任何现有测试，也没有运行完整套件。审查对象是当前工作区，包含已有未提交的新功能和测试。

## 1. 盘点口径和总量

通过 `vitest list --json` **收集而非执行**用例；`it.each` 按展开后计数，单个 `it` 内部的循环仍算一个用例。原始清单见 inventory.json（原始附件已转存私有验收资料）。520 是发现数，**不是本次全部通过的数量**，也不是覆盖率。

| 层级 | 文件 | 用例 | 分类口径 |
| --- | ---: | ---: | --- |
| unit | 14 | 164 | 纯逻辑、环境配置、状态机，或以模拟网络/数据库隔离的模块与客户端辅助逻辑 |
| integration | 19 | 356 | 真实 SQLite、文件系统、Fastify 路由、HTTP、子进程之间的集成 |
| 产品 E2E | 0 | 0 | 没有可通过项目命令重复运行的浏览器 → 当前应用 → 服务端 → 数据库完整流程 |
| 总计 | 33 | 520 | unit 内含独立原型的 3 文件 / 29 用例 |

分类用于选择执行文件，按文件的主要边界统计，并非把每个断言强行划成单一层级：例如 `scanner` 含年份函数断言，`album-grouping` 含客户端纯函数，`pathSafety` 含扫描器集成；这些文件整体归 integration。`config` 的临时目录用于确认配置加载没有创建运行时文件，没有启动服务，归 unit。`album-metadata-lookup` 的数据库是 Map/spy、网络是模拟响应，归 unit。

`playlist-client` 虽调用实际客户端 API、路由和 SQLite，但 fetch 被桥接到 `app.inject`，没有浏览器。`media` 确实启动 HTTP 和转码进程，但只挂载媒体处理器。`runtime-startup` 启动服务子进程并检查两种拒绝启动的情形，属于进程集成冒烟；三者均不计为完整用户流程 E2E。

新增的 `test:selection` 是测试命令自身的可重复验收，不计入上述现有产品测试数量，也不补足浏览器 E2E 缺口。

## 2. 文件、模块和功能对应

路径以仓库根目录为起点。每行的测试文件位于 `tests/`，省略 `.test.ts`。运行时清单及功能分组见 [test-catalog.mjs](../../scripts/test-catalog.mjs)。这是阅读依赖与断言得到的大致对应关系，不是覆盖率分析。

| 测试文件 | 层级 / 用例 | 主要源码与行为 | 选择范围 / 说明 |
| --- | --- | --- | --- |
| `audio` | unit / 4 | `server/audio.ts`，格式、MIME、AAC 直传/ALAC 转码策略 | `playback` |
| `config` | unit / 26 | `server/config.ts`，环境配置、生产密钥、Cookie、开关、端口 | `auth` / `scan` |
| `client-reliability` | unit / 12 | `client/api.ts`、`async-state.ts`、`room/room-state.ts`，取消、过期结果、扫描反馈 | `ui` / `scan` / `playback`；含旧辅助逻辑 |
| `library-data` | unit / 11 | `client/library-data.ts`、`api.ts`，全队列分页收集、版本变化和取消 | `catalog` / `ui` / `playback` |
| `library-pages` | unit / 4 | `client/library-pages.ts`，最后一页失效恢复 | `legacy`；当前入口未引用 |
| `mobile-layout` | unit / 21 | `client/mobile-layout.ts`，手机/iPad UA、480px 边界、SSR | `ui` / `playback`；不验证实际布局 |
| `seek-input` | unit / 11 | `client/seek-input.ts`，拖动/键盘状态机、防重复提交、换曲取消 | `ui` / `playback`；不验证 DOM 事件绑定 |
| `playback-position` | unit / 13 | `client/room/playback-position.ts`，完成/暂停/恢复边界 | `ui` / `playback`；不验证 audio 元素生命周期 |
| `playlist-state` | unit / 5 | `client/playlist-state.ts`，草稿、锁、创建后添加重试 | `playlists` / `legacy`；旧 `PlaylistView` 已不在当前入口链上 |
| `room-catalog` | unit / 9 | `client/request-id.ts`、`room/catalog-data.ts`，局域网请求 ID、部分失败、艺人索引 | `catalog` / `playlists` / `metadata` / `ui` |
| `album-metadata-lookup` | unit / 19 | `server/album-metadata.ts`、`musicbrainz.ts`、`client/room/metadata-draft.ts`，匹配、限流、超时、编辑保护 | `metadata` / `ui`；单文件混合服务端和前端逻辑 |
| `login-scene` | unit / 4 | **`prototypes/listening-room/src/login-scene.ts`**，动画生命周期 | `prototype`；未直接测试生产副本 |
| `prototype-state` | unit / 8 | **`prototypes/listening-room/src/prototype-state.ts`**，模拟扫描、排序、显示缺省 | `prototype` |
| `prototype-accounts` | unit / 17 | **`prototypes/listening-room/src/account-state.ts`**，模拟权限、表单、临时密码 | `prototype`；不是生产账号权限测试 |
| `db` | integration / 4 | `server/db.ts`，基础索引、收藏歌单、歌词路径、扫描错误/缓存 | `catalog`；通用 DB 改动宜显式选整个 integration |
| `album-grouping` | integration / 17 | `server/db.ts`、`album-identity.ts`，多碟/多艺人/版本隔离、旧键兼容、只读；另调用 `client/album-discs.ts` | `catalog`；保留服务端关键边界 |
| `library-pagination` | integration / 39 | `server/db.ts`、`routes.ts`，分页/搜索/版本、稳定顺序、万级详情 | `catalog` |
| `playlists` | integration / 37 | `server/db.ts`、`routes.ts`，CRUD、版本冲突、幂等、重开持久化、非法排列 | `playlists` |
| `playlist-client` | integration / 3 | `client/api.ts` → `server/routes.ts` → `db.ts`，生命周期、409、移除重试 | `playlists`；适合日常契约冒烟 |
| `routes` | integration / 40 | `server/routes.ts`、`db.ts`、旧认证，搜索、编码、参数、路径、响应 | `catalog` / `playback` / `paths` |
| `auth` | integration / 33 | `server/auth.ts` **无 database 参数的兼容路径**，HMAC Cookie | `auth` / `legacy`；不同于当前生产会话 |
| `accounts-integration` | integration / 17 | `server/accounts.ts`、`account-routes.ts`、`directories.ts`、`routes.ts`、`db.ts`、`maintenance.ts`，真实账号/隔离/目录/专辑管理 | `auth` / `playlists` / `scan` / `metadata` / `maintenance` / `paths` |
| `pathSafety` | integration / 6 | `server/pathSafety.ts`、扫描器/数据库，目录穿越、链接根目录、外部符号链接 | `paths` / `scan` |
| `scanner` | integration / 50 | `server/scanner.ts`、DB/真实临时文件，增量/force/prune/挂载/中断/缓存；模拟标签解析 | `scan` / `paths` / `metadata` |
| `scan-recovery` | integration / 15 | `server/db.ts`、`routes.ts`，遗留扫描恢复、普通连接不干扰、扫描参数/冲突 | `scan` / `maintenance` |
| `media` | integration / 12 | `server/media.ts`、`audio.ts`，HTTP 字节/Range、进程失败/断连、真实 ALAC 转码 | `playback`；FFmpeg 缺失时最后 1 项条件跳过 |
| `metadata` | integration / 11 | `server/metadata.ts`、真实 DB/缓存目录，MusicBrainz/LRCLIB 模拟响应、歌词选择/缓存 | `metadata` |
| `album-metadata` | integration / 5 | `server/db.ts`、`maintenance.ts`，人工覆盖、来源保留、版本、跨重启/备份 | `metadata` / `maintenance` |
| `album-enrichment` | integration / 19 | `server/album-enrichment.ts`、DB/备份，来源、人工保护、扫描竞争、关闭/超时/重试 | `metadata` / `scan` / `maintenance` |
| `artwork-import` | integration / 8 | `server/artwork-import.ts`、DB/锁/真实文件，离线封面导入和 CLI 参数 | `maintenance` / `paths` |
| `data-lock` | integration / 8 | `server/data-lock.ts`，真实 SQLite/进程锁、退出释放、链接与恢复标记 | `maintenance` / `paths` |
| `runtime-startup` | integration / 2 | 通过子进程执行 `server/index.ts`，锁占用和未完成恢复时拒绝启动 | `maintenance`；静态 import 图看不到完整依赖 |
| `maintenance` | integration / 30 | `server/maintenance.ts`、DB/缓存/锁，校验和/完整性、只恢复空目录、重定位、失败回滚 | `maintenance` / `paths` |

粗粒度风险：`routes.ts`、`db.ts` 是多个功能共享入口，功能组不保证覆盖所有调用方。只改输入手势可以选择一个文件；改共享 DB 模式、通用 API 序列化或共享类型契约，应扩大到相关集成文件，必要时显式选 integration 或全量。CSS、React 生命周期和真实浏览器行为不能靠依赖图或这些 unit 测试证明。

## 3. 哪些入口会默认跑全量

| 入口 | 审查前 | 本次调整后 |
| --- | --- | --- |
| `npm test` / `npm run test` | `vitest run`，匹配 `tests/**/*.test.ts` 全部 33 文件 | 必须提供精确文件；空参数显示用法并返回 1 |
| `npm test -- -t '…'` | 扫描全范围后筛用例名，仍会收集无关测试模块 | 不允许缺少文件；不会仅凭用例名隐式打开全库 |
| `npm test -- tests/audio.test.ts` | 按文件筛选 | 保留此用法；支持多文件及 `-t` |
| `npx vitest run` / `npm exec -- vitest run` | 全量 | 仍是底层全量入口，会绕过选择脚本；日常不推荐 |
| `npx vitest`（无文件参数） | 本地默认 watch，首次全量 | 未改变底层行为；需要 watch 时用 `npm test -- tests/seek-input.test.ts --watch` |
| `npm run test:all` | 无 | 明确全量，包括原型和兼容路径 |
| `npm run test:ci` | 无 | 明确全量，预检 FFmpeg、禁 `.only`、保存 JUnit |
| `typecheck` / `build` / `prototype:build` | 不执行测试 | 不执行测试 |

没有发现版本化的 CI 测试工作流（无 `.github/workflows` 等入口），原型 package.json 也没有 test 脚本。旧 README 和 AGENTS.md 的日常指引直接要求 `npm test`，会放大全量执行频率；本次已同步为按文件/功能选择。历史 QA 文档中的 `npm test` 和旧数量是当时记录，未重写成当前结果。

没有增加自动 `--changed` 入口：Vitest 的配置/package 触发规则可能扩大到全量，静态依赖筛选也不能可靠识别子进程、类型契约、CSS 和浏览器事件。当前工作区改动范围很大，自动选择不等于小范围。先 `--list` 看实际文件，再执行更可控。

## 4. 推荐保留

- **曲库和数据安全**：`pathSafety`、`scanner` 的增量/保留缺失索引/prune 挂载保护、`scan-recovery`、`data-lock`、`runtime-startup`、`maintenance`、`artwork-import`。不能因 happy path 集成通过就删除破坏性失败路径。
- **真实边界契约**：`media` 全部，尤其 Range 精确字节、断连进程回收和真实 ALAC；`playlist-client`；`playlists` 的竞争、重开持久化、非法排列和幂等；`accounts-integration` 的当前认证、隔离和撤销。
- **大曲库和元数据一致性**：`library-pagination`、`album-grouping`、`album-metadata`、`album-enrichment`、`metadata`、`album-metadata-lookup`。网络模拟使失败场景可重复，不因此降低价值。
- **便宜而有明确失败模式的 unit**：`audio`、`config`、`seek-input`、`playback-position`、`mobile-layout`、`library-data`、`room-catalog`，以及 `client-reliability` 中当前扫描状态提示。特别是 AAC/ALAC 判断和媒体集成处于不同边界，应同时保留。
- **原型仍在维护时的原型测试**：保留独立执行入口，全量仍包含它们；生产小改动不自动夹带原型测试。

## 5. 删除 / 合并 / 迁移候选（本次均未执行）

“重复”指相同前提和相同失败模式的断言重复；不同层级的保护不自动算冗余。“过时”在下表主要指当前生产入口不再触达被测实现，并不表示已证实该测试运行失败。由于没有跑完整套件，本次不宣称找到了全部运行失败或 flaky 用例。

| 候选与定位 | 类别 / 证据 | 推荐动作与前置条件 |
| --- | --- | --- |
| `db.test.ts:56`，`stores playlists and favorites` | 低增量覆盖 / 已有更高集成覆盖。仅断言收藏可列出、歌单能加一首；`playlist-client:50` 完整编辑生命周期已有对应断言，`playlists:64` 还验证源文件和状态 | 优先合并到 `playlist-client` 或保留为便宜的 DB 冒烟；不是必须删除。不要整文件删除：歌词路径、扫描错误/缓存各有用途 |
| `playlists.test.ts:64` 与 `playlist-client.test.ts:50` 的成功 CRUD 长流程 | 大段重复走创建/重命名/重排/删除；后者额外覆盖客户端序列化和 `ApiError` | 可以以客户端契约流为主，先补齐前者独有的 append、源音频字节不变、完整列表状态等断言再合并。保留重开 DB、竞争及非法输入测试 |
| `routes.test.ts:86` 的 `/api/tracks` 参数子集与 `library-pagination.test.ts:238` | 相同 400/错误响应在 `limit=-1/501`、`offset=-1/1.5` 上直接重复；无效文本 limit 也属同类 | 统一到分页参数矩阵。保留 `favorite`、扫描错误 limit、stream 的 start/mode 等分页文件没有覆盖的入口 |
| `routes.test.ts:113` 的缺失歌单添加 404 与 `playlists.test.ts:243` | 相同资源缺失路径和响应，后者覆盖全部修改端点及未知歌曲 | 可合并资源 404 断言；旧认证装配与无认证 fixture 不等价，当前账号权限仍需 `accounts-integration` 验证 |
| `library-pages.test.ts` 全部 4 项 | 覆盖对象过时。`library-pages.ts` 当前没有生产导入方，`App` 已进入 `room/Room` | 确认不再维护旧分页组件后，随旧源码一起退役；当前先置于 `legacy` 范围，保留全量覆盖。它不是当前目录分页的保护 |
| `playlist-state.test.ts` 全部 5 项 | 覆盖对象过时。排序仅被未接入当前 App 的 `PlaylistView` 调用，锁/创建后重试辅助函数没有生产调用方 | 应先为当前 `room/Room` + `PlaylistOrderEditor` 建立排序、创建部分失败和重试 E2E，再决定迁移或随旧源码删除；`prototype-state` 测同形算法不能替代生产测试 |
| `auth.test.ts` 33 项 | 覆盖对象错位。fixture 调用 `registerAuth(app, config)`；生产 `server/index.ts:29` 传 database，走 `accounts.ts` 的数据库会话；旧 token 格式/身份断言不是当前会话契约 | 不立即删除。将仍适用的 Cookie flags、过期、伪造和退出场景迁移到当前认证；确认兼容分支不再受支持后才删旧格式断言。当前 `accounts-integration` 覆盖部分登录/权限/撤销，但不足以替代 33 项全部安全边界 |
| `login-scene.test.ts:2`、`prototype-accounts.test.ts:2`、`prototype-state.test.ts:2` | 仅导入原型。生产有独立 `room/login-scene.ts`、`account-state.ts`、`room-state.ts`，原型绿灯不会捕捉生产副本回归；本次比对两份 login-scene 相同，但以后可分叉 | 优先共享代码或对生产导出迁移/参数化测试。原型仍维护时保留模拟扫描专属测试；不要把模拟扫描结果当成真实扫描 E2E |
| `client-reliability.test.ts:14、36、142` 的旧请求仲裁/播放错误辅助逻辑 | `createLatestRequest` 目前仅被旧 `library-pages`/`PlaylistView` 使用，`playbackErrorMessage` 没有当前 UI 调用方；`scanJustFinished` / 当前扫描反馈仍在使用 | 拆分现行契约与旧辅助行为，迁移竞态/错误展示到当前 `room/data.ts`、`room/player.ts` 浏览器流程；不要删除整个文件或 API AbortSignal 契约 |
| `scanner.test.ts:315` 的 `readdir` 精确 2/4 次 | 实现细节耦合。不同但仍高效的遍历实现会使断言失败；不过 NAS 目录 I/O 性能是有效需求 | 改为明确的目录遍历预算/随目录数增长的上界，并保留“未变文件不解析、不写索引”的行为断言；不是因调用次数断言就删除性能保护 |
| `login-scene.test.ts:51` 的 drawImage 参数、离屏画布和 transform 精确断言 | 依赖当前双缓冲绘制方法；改渲染方式可能假失败 | 保留不重复分配、不重复 RAF、后台暂停、reduce-motion、卸载清理等有明确失败模式的检查；画面完整性用生产动画 targeted E2E/截图补足后再精简绘制步骤断言 |
| `mobile-layout.test.ts:13` 的 479/479.5/479.999，以及 480.01/852/1280 | 同一等价区间内部分输入的边际价值小，且运行本身很便宜 | 可合并成有代表性的区间和紧邻 480 的边界；优先级低。保留手机宽视口、桌面 UA iPad、无效宽度等不同分支 |

没有发现整段通过源文件文本匹配来替代行为验证的测试，也没有 `.only` / `.todo` 或无条件跳过。唯一明确的条件跳过是 `media.test.ts:211` 的 FFmpeg 探测：开发机器缺依赖会跳过真实转码，这不算失效测试，但 CI 必须显式防止漏验，本次已加预检。

没有证据支持“某项已被浏览器 E2E 完全覆盖”，因为自动化浏览器 E2E 尚不存在。表中的更高层覆盖来自现有 integration，并逐项保留其没有保护的边界。

## 6. 主要用户流程与 targeted E2E 缺口

仓库的 `docs/qa/`、`docs/audits/`、原型验收目录有截图、实际浏览器操作记录和 JSON 请求证据。例如 [播放重播验收](../qa/playback-replay-2026-09-28/README.md)、[在线专辑信息验收](../qa/online-album-metadata-2026-09-28/README.md)。它们有助于人工复验，但没有版本化自动场景、fixture 启停和运行命令，不能当成持续可重复的自动 E2E。

下表每个流程目前的 targeted 浏览器 E2E 都是“无”。文件名是建议新增的场景，不是已可执行的脚本。

| 优先级 / 建议场景 | 当前已有覆盖 | 应验证的用户动作和失败模式 |
| --- | --- | --- |
| P0 `e2e/auth.spec.ts` | `accounts-integration`；旧 `auth` 只覆盖兼容分支 | 登录→首用改密→返回原页面→退出；过期会话、Cookie HTTP/HTTPS 配置、管理员/普通账号界面与实际权限一致 |
| P0 `e2e/library-scan.spec.ts` | `scanner`、`scan-recovery`、目录 API（扫描器在账号 fixture 中是 mock） | 选择临时目录→真实扫描→展示完成并刷新→再次增量扫描；停止、NAS 路径不可用、部分失败、清理拒绝时保留收藏/歌单 |
| P0 `e2e/playback.spec.ts` | `audio`、`media`、`seek-input`、`playback-position` | AAC M4A 直传、ALAC/FLAC 实际转码；暂停/继续、拖动、自然结束后从零重播、完成后刷新不请求曲尾空流、自动下一首/循环 |
| P0 `e2e/playlists.spec.ts` | `playlist-client`、`playlists`、账号隔离 | 创建→添加→拖动/键盘排序→保存→刷新→移除/删除；双击幂等、响应丢失重试、409 保留草稿、另一账号不可读写 |
| P1 `e2e/catalog.spec.ts` | `library-pagination`、`album-grouping`、`library-data`、`room-catalog` | 搜索→含中文/%/斜杠的专辑/艺人详情→收藏→跨页整队列播放；请求乱序、失败重试、数据变更，覆盖真实 UI 装配 |
| P1 `e2e/album-metadata.spec.ts` | 专辑查询、草稿、覆盖和后台补全测试较完整 | 自动查询→候选选择→查询中编辑→保存→刷新；歧义/超时/409 不覆盖输入，后台补全后 UI 接收 revision 更新 |
| P1 `e2e/mobile-player.spec.ts` | UA/宽度策略、seek 状态机；已有人工截图 | 手机 UA 的胶囊播放器→全屏→歌词/队列；触控/键盘、横竖屏、iPad 保持桌面/平板规则；验证点击目标和实际滚动/溢出 |
| P1 `e2e/maintenance.spec.ts`（CLI/服务系统流程） | `maintenance` 调用 main/函数、真实锁、启动拒绝、账号和元数据备份 | 用构建后的 CLI 备份→空 DATA_DIR 恢复→启动服务→登录并读取收藏/歌单/缓存；校验音乐哈希、SQLite 完整性以及恢复路径 |

实施时先从失败模式写场景，再写实现。每个场景独立创建 DATA_DIR 和可生成的短音频 fixture，不能使用或修改真实 NAS 曲库。在线提供方用可控响应，另设可选 live 验证，避免 CI 依赖外网。产品构建、真实浏览器和真实本地服务连通；只模拟上游边界，不伪造 audio ended 或内部 React 状态来证明播放流程。

每次 targeted E2E 必须输出可复验 artifact：场景名/命令/源码版本/浏览器与视口、结构化断言结果、关键截图、失败 trace；播放额外保存 stream/Range/start 请求记录和 fixture 哈希，维护额外保存 manifest/SQLite 校验结果。建议新增 `test:e2e` 按 spec/标签运行、CI 再显式纳入全部 E2E；本次不提供会假通过的空 `test:e2e` 命令。

## 7. 日常命令与 CI 建议

```bash
# 查看范围；--list 只看文件和拟执行参数，不导入测试模块
npm run test:list
npm run test:scope -- playlists --list

# 最窄范围：精确文件，必要时再按用例名缩小
npm test -- tests/seek-input.test.ts
npm test -- tests/audio.test.ts -t 'AAC|ALAC'
npm test -- tests/playlist-client.test.ts
npm test -- tests/accounts-integration.test.ts -t 'album information administration'

# 功能变更：多个功能取并集，不重复执行同一个文件
npm run test:scope -- playlists
npm run test:scope -- scan metadata --list
npm run test:scope -- scan metadata

# 跨模块或特定层级变更，明确扩大范围
npm run test:unit
npm run test:integration
npm run test:prototype

# 仅需要增量重复调试某文件时开启 watch
npm test -- tests/seek-input.test.ts --watch

# 开发交付的基本检查
npm run typecheck
npm run build
git diff --check

# 明确要求全量时；本次审查未执行
npm run test:all

# CI（先 npm ci，并确保 FFmpeg、原生 SQLite 依赖和本地端口/子进程可用）
npm run typecheck && npm run build && npm run test:ci && git diff --check
```

`test:ci` 运行所有现有测试（包括 prototype / legacy），不接受 `-t` 等缩小范围的附加参数，缺 FFmpeg 会失败，输出 `artifacts/tests/ci.xml`，CI 无论成功失败都应上传该报告。不要继续把裸 `npm test` 当成 CI；新行为会明确报错，防止未执行任何测试却显示成功。当前没有实装 CI 工作流，以上是可直接采用的命令建议；自动浏览器 E2E 需建好后再加入。

显式局部执行仍保留失败码，零文件、拼错功能、未知选项、零匹配用例都不能静默通过。新测试未登记或文件移动会让选择脚本失败，提醒更新清单。`test:unit` 包含所有 unit（也含原型），并不是“默认快速”套件。对变更范围有疑问时先扩大到相关集成测试，而不是删除测试来换速度。

## 8. 本次变更与验证证据

- 保留全部 33 文件 / 520 现有用例，`vitest.config.ts` 的完整 include 不变，不加排除项、不改业务实现或依赖。
- `package.json` 增加文件、功能、层级、原型、清单、全量和 CI 入口；[test.mjs](../../scripts/test.mjs) 校验范围并调用原有 Vitest。
- 同步 README 和 AGENTS.md；`artifacts/` 忽略临时报告，审查证据另保存在本目录。
- 先写 [命令验收需求](selector-acceptance-plan.md) 和 [命令验收脚本](../../scripts/verify-test-selection.mjs)，再实现选择入口。
- `npm run test:selection`：11 项命令验收通过；只实际执行 `audio` 4 项与 `playlist-client` 3 项，共 2 文件 / 7 项通过。用例名零匹配检查只收集所选文件后拒绝执行。
- `npm run typecheck`、`npm run build`、`git diff --check`：通过。未实跑 `test:all`、`test:integration` 或 `test:ci`；全量集合与 CI 参数仅预览验收，不能据此宣称全量通过。
- 复验执行 `npm run test:selection`；输出 `artifacts/test-selection/acceptance.json`、`targeted.json`、日志。归档见 验收结果（原始附件已转存私有验收资料）、7 项定向结果（原始附件已转存私有验收资料） 和 版本、命令及文件哈希（原始附件已转存私有验收资料）。

本次没有对完整套件作计时，不能承诺具体节省多少秒。可见的收益是把日常一个小模块的执行范围从默认 33 文件收敛到明确的 1 文件或功能集合，同时保留 CI 的全部现有保护。
