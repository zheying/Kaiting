# 测试整改结果 · 2026-09-28

> 隐私说明：环境地址和路径已替换为示例；原始验收附件在仓库外私有保存，不随仓库发布。

已按审查建议建立局部执行入口、补齐八类用户流程的自动 E2E、迁移生产测试契约并合并明确重复的断言。没有删除任何测试文件，没有修改业务源码或真实曲库。工作区原有业务改动保留。

## 数量与覆盖边界

下面是收集数量，不代表执行过整个套件。`it.each` 按展开后计数，文件按主要测试边界分类。

| 层级 | 审查前文件 / 用例 | 当前文件 / 用例 |
| --- | ---: | ---: |
| unit | 14 / 164 | 18 / 180 |
| integration | 19 / 356 | 20 / 364 |
| E2E | 0 / 0 | 8 / 26 |
| 合计 | 33 / 520 | 46 / 570 |

总数增加了 50 项，因为补上了生产契约与用户流程。日常选择按文件或功能进行：独立原型的 29 项、legacy 的 45 项仍在全量清单，生产功能不会自动捎带这些文件。没有用删安全边界、无条件 skip 或放宽生产保护换取速度。

清单来源：unit/integration（原始附件已转存私有验收资料）、E2E（原始附件已转存私有验收资料）。可用 `npm run test:inventory` 重新收集，不启动浏览器和服务。完整初始模块映射见[原始审查](test-audit-2026-09-28.md)，当前功能选择以 [test-catalog.mjs](../../scripts/test-catalog.mjs) 为准。

## 十二组候选的实际处置

| 审查候选 | 已完成的动作与保留理由 |
| --- | --- |
| `db` 基础收藏/歌单用例 | 合入 `playlist-client` 完整生命周期；补上真实客户端的收藏筛选检查。`db` 的索引、歌词路径、错误/缓存测试保留 |
| `playlists` 与 `playlist-client` 重复 CRUD | 创建、重命名、排序、移除后再追加、重复添加、删除清理、收藏与源音频字节不变集中到 `playlist-client`。API 独有的 description 保留为短用例；并发、重开数据库和非法输入仍在 `playlists` |
| `routes` 重复分页边界 | 移除 4 个重复参数样本，由 `library-pagination` 保留并验证 400 响应。`routes` 仍保留独立的非法类型、收藏、扫描和媒体参数验证 |
| `routes` 缺失歌单 404 | 合入 `playlists` 对全部修改端点的 404 检查，并保留响应正文断言。当前账号隔离另由 integration/E2E 验证 |
| `library-pages` 4 项 | 保留在 `legacy`。旧源码尚未退役，不单独删掉它的保护；它不代表生产页面覆盖 |
| `playlist-state` 5 项 | 保留在 `legacy` 并移出生产歌单范围；当前页面已有键盘/指针排序、失败重试、409 草稿保护 E2E |
| 旧 `auth` 33 项 | 完整移到 `legacy-auth`。新的 `auth` 14 项使用生产数据库会话，验证 Cookie flags、伪造/过期、密钥轮换、退出后不可重放。兼容分支仍存在，未删除其安全边界 |
| 原型副本测试 | 生产 `account-state` 14 项、`room-state` 4 项、`login-scene` 4 项与原型共用契约文件。原型保留独有的模拟扫描/临时密码生成测试，独立选择执行 |
| `client-reliability` 旧辅助逻辑 | 3 项移入 `legacy-client-state`；保留现行 API 取消、错误传递、扫描刷新/终态反馈。浏览器侧新增晚到响应、播放断网/丢失文件恢复 |
| 扫描器精确 readdir 2/4 次 | 改成每轮最多两次目录读取的性能预算，仍验证 12 首未改动歌曲全部跳过解析；允许更高效的实现通过 |
| 登录背景绘制细节 | 去掉固定 `drawImage(buffer, 0, 0)` 和 transform 参数断言；保留分配、RAF、隐藏/恢复、reduce-motion 和卸载契约，并补生产登录画布截图/重入 E2E |
| 移动宽度重复采样 | 保留 479.999/480 紧邻边界，合并同等区间的 6 项；手机宽视口、两种 iPad、触摸电脑、无效宽度和 SSR 仍保留 |

已有测试中净合并 12 个展开用例；新补 36 个生产 unit/integration 契约和 26 个 E2E。没有整文件删除。以后只有在旧代码一并退役且不再支持其调用方时，才考虑删除 `legacy` 文件；现在没有必须立即删除的测试。

继续保留路径安全、prune/挂载保护、扫描恢复、锁、维护回滚、真实媒体 Range/进程回收、并发版本和非法输入。浏览器成功流程不能替代这些边界。

## 新增 E2E 与源码关系

| 选择范围 / 用例 | 主要生产模块 | 实际验证 |
| --- | --- | --- |
| `auth` / 2 | `LoginScreen`、`AccountPages`、`accounts`、`account-routes` | 错误凭据、登录退出、临时密码首用改密、普通成员权限、会话撤销后恢复原页面 |
| `library-scan` / 4 | `Room`、`directories`、`scanner`、`db` | 选择目录真实扫描、增量跳过、坏音频详情、中断继续、目录离线/prune 失败保留收藏歌单 |
| `playback` / 5 | `room/player`、`CapsulePlayer`、`media`、`audio` | AAC 直传、ALAC/FLAC 真实转码；暂停 seek、自然结束、刷新重播、循环和自动下一首；断网重试与丢失文件跳过 |
| `playlists` / 4 | `Room`、`PlaylistOrderEditor`、`api`、`routes`、`db` | 编辑全流程、键盘/鼠标排序、刷新、丢失创建响应/添加失败后重试、重复点击、409 草稿、私人歌单隔离 |
| `catalog` / 3 | `Room`、`room/data`、`catalog-data`、分页 API | 中文/%/斜杠搜索与导航、收藏持久化、部分失败单独重试、晚到请求、505 首完整队列 |
| `album-metadata` / 3 | `AlbumMetadataForm`、`metadata-draft`、`musicbrainz`、`album-enrichment` | 真实 API/DB 查询保存、人工输入保护、上游失败重试、歧义选择、真实 409 与明确重载、后台补全刷新已开页面 |
| `mobile-player` / 4 | `mobile-layout`、`CapsulePlayer`、`NowPlaying`、`LoginBackdrop` | 手机胶囊→全屏→触摸进度→歌词/队列；桌面跨 480 宽度切换、iPad 保持平板规则；静态登录背景/重入 |
| `maintenance` / 1 | 构建后的 `maintenance`/`artwork-import` CLI、服务、SQLite | 备份→新 DATA_DIR 恢复→重启→页面读回收藏/歌单/封面；缓存路径重定位、源音乐哈希与数据库完整性 |

每例启动真实生产服务、临时 SQLite、FFmpeg 生成的短音频，完成后校验音乐文件哈希并清理临时目录。只在外部边界注入故障；MusicBrainz 被隔离的本地上游替代，不访问真实外网。没有模拟 `ended`、改音频 `currentTime` 或操作 React 内部状态。

当前手机/iPad 是 Chrome 模拟环境。为了模拟真实 iPhone，补齐了 Chrome 在 macOS 模拟时不会自动改变的 `navigator.platform`；不把宿主机 `MacIntel` 误当成手机的平台。真实 iOS Safari、真实 NAS 挂载及在线提供方的 live 行为仍属于独立设备/环境验收范围。

## 日常与 CI 命令

```bash
# 小改动：文件或功能，先预览
npm test -- tests/seek-input.test.ts
npm run test:scope -- playlists --list
npm run test:scope -- playlists

# 用户可见行为：优先单一 E2E，可继续筛用例名
npm run test:e2e -- playback
npm run test:e2e -- playlists -g '重试'
npm run test:e2e -- mobile-player -g '胶囊'
npm run test:e2e -- auth library-scan --list

# 全量是明确动作；CI 包含所有层级
npm run test:all
npm run test:e2e:all
npm run test:ci -- --list
npm run test:ci
```

`npm test`、裸 `test:e2e`、拼错文件/范围、用例名零匹配均明确失败。`--list` 仅预览范围。底层 `npx vitest run` 和 `npx playwright test` 仍会全量执行，应避免当日常入口。

CI 工作流为 [.github/workflows/tests.yml](../../.github/workflows/tests.yml)：Node 22、FFmpeg、独立 Chrome for Testing，预检浏览器与 AAC 解码器，类型检查→构建→选择命令和浏览器保护验收→所有 unit/integration→所有 E2E→diff 检查。禁止 `.only`，任一步失败即返回失败，最终上传完整报告。`test:ci:node` 只是其中一个步骤。2026-09-29 将系统 Chrome 改为独立测试通道并增加启动保护，见 [浏览器隔离验收计划](browser-isolation-plan.md)。

## 已执行验证与证据

- **296 个不同展开 unit/integration 用例通过，涉及 18 个文件**。迁移批次 125、合并批次 167、命令验收补验音频 4 项；重复执行不重复计数。见 node-results.json（原始附件已转存私有验收资料）。
- **26 个 E2E 场景均有通过证据**，按功能逐批运行并修正初始测试定位/设备模拟问题；不是一次全量套件运行。另以两个 worker 验证隔离执行。见 e2e-results.json（原始附件已转存私有验收资料）。
- **16 项命令契约验收通过**，包含无参数、拼写、精确范围、legacy 隔离、零匹配、清单漂移、失败码及 CI 编排。见 selector-acceptance.json（原始附件已转存私有验收资料）。
- `npm run typecheck`、`npm run build`、`git diff --check` 通过。还实际运行了日常 `test:e2e` 默认构建入口，验证不会扩大到其他场景。见 verification.json（原始附件已转存私有验收资料）。

**没有运行整个既有 unit/integration 套件，也没有执行完整 CI 或 GitHub 托管机任务。** CI 配置的远程通过状态尚未获得；本次不把本机局部绿灯写成全量通过。

每个场景的原始 HTML/JSON/JUnit、trace、网络日志、服务日志、逐例截图在 `artifacts/e2e/`；初始失败也保留，汇总以各场景最近一次实际执行为准。证据清单记录原始产物路径和哈希。源码/构建指纹（原始附件已转存私有验收资料） 对应最后一次已构建的定向运行，可核对未提交工作区，而不只依赖 Git HEAD。

代表截图：手机胶囊（原始附件已转存私有验收资料）、专辑信息保存（原始附件已转存私有验收资料）、恢复后的歌单（原始附件已转存私有验收资料）、减少动态效果的登录页（原始附件已转存私有验收资料）。截图已查看；测试主要靠可观察行为断言，未设置易受环境影响的整页像素门槛。
