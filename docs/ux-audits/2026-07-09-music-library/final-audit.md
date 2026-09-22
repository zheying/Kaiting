# Music Library UX 审计问题清单

审计日期：2026-07-09
证据目录：docs/ux-audits/2026-07-09-music-library

## 审计范围
- 登录、首页、空曲库、专辑/艺人浏览、搜索、收藏、歌单、歌曲菜单、底部播放器、队列、全屏播放页、歌词、窄视口表现。
- 真实库数据：1054 首歌曲、11 张专辑、6 个艺人、2 个空歌单、0 个收藏。
- 未触发真实库扫描；空曲库用 /private/tmp 临时 DATA_DIR 验证。

## P0 阻断
未发现阻断级问题。核心路径可以登录、浏览、搜索并进入播放界面。

## P1 高影响
1. 收藏和空歌单是死胡同。证据：09-favorites-empty.png、12-playlist-detail-empty.png。0 收藏和 0 首歌单只显示标题，没有解释如何添加、没有跳转到歌曲列表或最近加入，用户进入后不知道下一步。
2. 艺人详情把大量歌曲平铺，缺少专辑分组。证据：08-artist-detail.png。SQUARE ENIX MUSIC 直接显示 472 首，艺人页没有专辑维度，浏览和定位成本高。
3. 搜索结果不进入独立可分享状态。证据：06-search-results-final.png。搜索后显示结果，但 URL 仍停在原专辑详情 hash，返回/刷新/分享语义不清楚。
4. 播放状态一致性需要实机复核。证据：14-bottom-player-playing.png、16-fullscreen-player-default.png。音频流 readyState=4 且有 currentSrc，但浏览器报告 audio paused；全屏主按钮显示“播放”，没有解释是否被自动播放策略或加载状态阻断。
5. 歌单管理能力不足。证据：10-playlists-list-empty-playlists.png、11-playlist-create-validation.png、12-playlist-detail-empty.png。可以创建和添加，但没有删除、重命名、描述编辑、排序、单首移除等明显管理入口；创建成功会留下不可清理对象。

## P2 可优化
1. 首页把运维状态和听歌入口混在一起。证据：03-home-library-overview.png。统计、扫描、元数据、错误文件、最近加入、歌曲列表同屏出现，普通听歌用户的主行动不够突出。
2. 空曲库有两个扫描 CTA，缺少预期说明。证据：20-empty-library-state.png。顶部“扫描曲库”和空状态“开始扫描”同时出现，但没有说明扫描耗时、只读保证、支持格式或失败后如何处理。
3. 歌曲更多菜单可发现性弱。证据：13-track-menu-add-to-playlist.png。添加歌单/收藏藏在省略号里，子菜单横向展开，在窄宽度或靠边位置存在越界风险。
4. 队列管理偏轻。证据：15-queue-drawer.png。能查看和清除后续，但没有拖拽排序、单曲移除、当前播放锚点或队列来源说明。
5. 歌词入口反馈不足。证据：16-fullscreen-player-default.png、17-fullscreen-lyrics-panel.png。无歌词时只禁用图标并靠 title 提示；有歌词时体验成立，但加载、无歌词、在线补全之间缺少可见差异。
6. 专辑墙和搜索缺少规模化工具。证据：04-albums-grid.png、06-search-results-final.png。没有排序、筛选、结果数量、匹配原因或“无结果建议”，库变大后效率会下降。
7. 错误提示可访问性需加强。证据：02-login-error.png、11-playlist-create-validation.png。错误可见，但截图和 DOM 抽查未看到明确 aria-describedby 关联；读屏器播报需进一步验证。
8. 移动端验证依赖真实 UA。证据：18-narrow-viewport-desktop-ua.png。390px 视口仍是 app-shell，不会等同移动端；当前实现需要真机或可改 UA 环境覆盖移动 shell。

## 已确认的优点
- 登录、基础导航、专辑墙、详情页、搜索、播放器、队列和歌词面板均有可用路径。
- 桌面端信息密度适合个人曲库管理，封面资源加载稳定。
- 音频流能返回并进入 ready 状态，ALAC/转码路径至少可被前端请求到。
- 图标按钮大多有 title 或 aria-label，进度和音量 range 有 aria-label。

## 审计限制
- in-app Browser 无 UA 改写能力，移动 UA 专属 shell 未能完整截图。
- 未点击真实库“扫描曲库”，避免修改扫描状态。
- 未创建新歌单、未真实添加歌曲到歌单，避免留下不可删除的审计数据。
- 截图不能证明完整 WCAG 合规；键盘顺序、读屏器播报和实际手机触控仍需专项验证。
