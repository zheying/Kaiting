# 状态页滚动修正验收

2026-09-28。修正范围：原型的目录与扫描状态、账号列表状态、格式筛选空态、搜索无结果、列表与详情失败，以及首次设置、空库和 404。

短状态页改用弹性布局，按实际页头、工具栏与播放器留白分配空间；长内容保持自然滚动。目录错误的手机操作与诊断信息收紧，账号无结果不再渲染空表头。入场动画改为淡入，避免位移造成瞬时或残留的 5px 滚动范围。

## 验证结果

- 桌面 1108×879 与手机 393×852：16 个受影响状态的主区域、根文档、横向滚动溢出均为 0，恢复按钮全部位于播放器上方。
- 桌面 1024×768：上述 16 个状态均无多余滚动。
- 手机 393×667：扫描、目录和基础空态使用紧凑排版；账号页保留完整标题、管理控件及说明，因此仍需 179px 正常滚动。已实测 End 键滚至底部，恢复按钮底边约 497px，位于播放器顶边 603px 以上，内容可完整触达。
- 正式目录错误、搜索无结果、设置空库、曲库读取失败、曲库载入、FLAC 无结果：桌面和手机均无多余滚动。
- 回归空歌单集合、单张空歌单、空收藏：桌面与两种手机高度均无多余滚动。
- FLAC 空态点击“查看全部歌曲”恢复完整列表和正常长列表滚动；账号无结果点击“查看全部账号”恢复 4 条账号和表头；账号载入失败点击“重新载入”恢复列表。
- 仅调整原型布局与空表头的显示条件，未修改扫描、数据库、权限或真实用户数据逻辑。没有提交 Git。

## 快速查看

| 类别 | 页面链接 |
| --- | --- |
| 目录与扫描 | [目录不可访问](http://127.0.0.1:4173/#/preview/directory-unavailable) · [扫描失败](http://127.0.0.1:4173/#/preview/scan-failed) · [扫描中断](http://127.0.0.1:4173/#/preview/scan-interrupted) · [扫描中](http://127.0.0.1:4173/#/preview/scan-running) · [未发现音乐](http://127.0.0.1:4173/#/preview/scan-empty) |
| 账号管理 | [载入中](http://127.0.0.1:4173/#/preview/accounts-loading) · [载入失败](http://127.0.0.1:4173/#/preview/accounts-error) · [搜索无结果](http://127.0.0.1:4173/#/preview/accounts-empty) |
| 搜索与列表 | [搜索无结果](http://127.0.0.1:4173/#/preview/search-empty) · [列表载入失败](http://127.0.0.1:4173/#/preview/list-error) · [详情载入失败](http://127.0.0.1:4173/#/preview/detail-error) · [歌曲页（点击 FLAC）](http://127.0.0.1:4173/#/songs) |
| 初次与缺省状态 | [首次设置](http://127.0.0.1:4173/#/preview/setup-empty) · [空曲库](http://127.0.0.1:4173/#/preview/library-empty) · [空专辑](http://127.0.0.1:4173/#/preview/albums-empty) · [空艺人](http://127.0.0.1:4173/#/preview/artists-empty) · [404](http://127.0.0.1:4173/#/preview/not-found) |
| 共用布局回归 | [空歌单集合](http://127.0.0.1:4173/#/preview/playlists-empty) · [单张空歌单](http://127.0.0.1:4173/#/preview/playlist-empty) · [空收藏](http://127.0.0.1:4173/#/preview/favorites-empty) · [曲库载入](http://127.0.0.1:4173/#/loading) · [曲库读取失败](http://127.0.0.1:4173/#/error) |

## 截图与尺寸记录

以下为最终每种尺寸的主区域可滚动范围。账号短屏的正常滚动不作为缺陷；未使用 overflow:hidden 遮蔽正文。

| 页面 | 尺寸 | 可滚动范围(px) | 截图 |
| --- | --- | ---: | --- |
| [初次设置](http://127.0.0.1:4173/#/preview/setup-empty) | 桌面 1108×879 | 0 | [截图](desktop-setup-empty.jpg) |
| [曲库为空](http://127.0.0.1:4173/#/preview/library-empty) | 桌面 1108×879 | 0 | [截图](desktop-library-empty.jpg) |
| [账号列表载入中](http://127.0.0.1:4173/#/preview/accounts-loading) | 桌面 1108×879 | 0 | [截图](desktop-accounts-loading.jpg) |
| [账号列表载入失败](http://127.0.0.1:4173/#/preview/accounts-error) | 桌面 1108×879 | 0 | [截图](desktop-accounts-error.jpg) |
| [账号搜索无结果](http://127.0.0.1:4173/#/preview/accounts-empty) | 桌面 1108×879 | 0 | [截图](desktop-accounts-empty.jpg) |
| [扫描进行中](http://127.0.0.1:4173/#/preview/scan-running) | 桌面 1108×879 | 0 | [截图](desktop-scan-running.jpg) |
| [未发现音乐](http://127.0.0.1:4173/#/preview/scan-empty) | 桌面 1108×879 | 0 | [截图](desktop-scan-empty.jpg) |
| [无法启动扫描](http://127.0.0.1:4173/#/preview/scan-failed) | 桌面 1108×879 | 0 | [截图](desktop-scan-failed.jpg) |
| [扫描中断](http://127.0.0.1:4173/#/preview/scan-interrupted) | 桌面 1108×879 | 0 | [截图](desktop-scan-interrupted.jpg) |
| [目录不可访问](http://127.0.0.1:4173/#/preview/directory-unavailable) | 桌面 1108×879 | 0 | [截图](desktop-directory-unavailable.jpg) |
| [没有搜索结果](http://127.0.0.1:4173/#/preview/search-empty) | 桌面 1108×879 | 0 | [截图](desktop-search-empty.jpg) |
| [没有专辑](http://127.0.0.1:4173/#/preview/albums-empty) | 桌面 1108×879 | 0 | [截图](desktop-albums-empty.jpg) |
| [没有艺人](http://127.0.0.1:4173/#/preview/artists-empty) | 桌面 1108×879 | 0 | [截图](desktop-artists-empty.jpg) |
| [列表载入失败](http://127.0.0.1:4173/#/preview/list-error) | 桌面 1108×879 | 0 | [截图](desktop-list-error.jpg) |
| [详情载入失败](http://127.0.0.1:4173/#/preview/detail-error) | 桌面 1108×879 | 0 | [截图](desktop-detail-error.jpg) |
| [页面不存在](http://127.0.0.1:4173/#/preview/not-found) | 桌面 1108×879 | 0 | [截图](desktop-not-found.jpg) |
| [初次设置](http://127.0.0.1:4173/#/preview/setup-empty) | 手机 393×852 | 0 | [截图](mobile-setup-empty.jpg) |
| [曲库为空](http://127.0.0.1:4173/#/preview/library-empty) | 手机 393×852 | 0 | [截图](mobile-library-empty.jpg) |
| [账号列表载入中](http://127.0.0.1:4173/#/preview/accounts-loading) | 手机 393×852 | 0 | [截图](mobile-accounts-loading.jpg) |
| [账号列表载入失败](http://127.0.0.1:4173/#/preview/accounts-error) | 手机 393×852 | 0 | [截图](mobile-accounts-error.jpg) |
| [账号搜索无结果](http://127.0.0.1:4173/#/preview/accounts-empty) | 手机 393×852 | 0 | [截图](mobile-accounts-empty.jpg) |
| [扫描进行中](http://127.0.0.1:4173/#/preview/scan-running) | 手机 393×852 | 0 | [截图](mobile-scan-running.jpg) |
| [未发现音乐](http://127.0.0.1:4173/#/preview/scan-empty) | 手机 393×852 | 0 | [截图](mobile-scan-empty.jpg) |
| [无法启动扫描](http://127.0.0.1:4173/#/preview/scan-failed) | 手机 393×852 | 0 | [截图](mobile-scan-failed.jpg) |
| [扫描中断](http://127.0.0.1:4173/#/preview/scan-interrupted) | 手机 393×852 | 0 | [截图](mobile-scan-interrupted.jpg) |
| [目录不可访问](http://127.0.0.1:4173/#/preview/directory-unavailable) | 手机 393×852 | 0 | [截图](mobile-directory-unavailable.jpg) |
| [没有搜索结果](http://127.0.0.1:4173/#/preview/search-empty) | 手机 393×852 | 0 | [截图](mobile-search-empty.jpg) |
| [没有专辑](http://127.0.0.1:4173/#/preview/albums-empty) | 手机 393×852 | 0 | [截图](mobile-albums-empty.jpg) |
| [没有艺人](http://127.0.0.1:4173/#/preview/artists-empty) | 手机 393×852 | 0 | [截图](mobile-artists-empty.jpg) |
| [列表载入失败](http://127.0.0.1:4173/#/preview/list-error) | 手机 393×852 | 0 | [截图](mobile-list-error.jpg) |
| [详情载入失败](http://127.0.0.1:4173/#/preview/detail-error) | 手机 393×852 | 0 | [截图](mobile-detail-error.jpg) |
| [页面不存在](http://127.0.0.1:4173/#/preview/not-found) | 手机 393×852 | 0 | [截图](mobile-not-found.jpg) |
| [初次设置](http://127.0.0.1:4173/#/preview/setup-empty) | 桌面 1024×768 | 0 | [截图](desktop-short-setup-empty.jpg) |
| [曲库为空](http://127.0.0.1:4173/#/preview/library-empty) | 桌面 1024×768 | 0 | [截图](desktop-short-library-empty.jpg) |
| [账号列表载入中](http://127.0.0.1:4173/#/preview/accounts-loading) | 桌面 1024×768 | 0 | [截图](desktop-short-accounts-loading.jpg) |
| [账号列表载入失败](http://127.0.0.1:4173/#/preview/accounts-error) | 桌面 1024×768 | 0 | [截图](desktop-short-accounts-error.jpg) |
| [账号搜索无结果](http://127.0.0.1:4173/#/preview/accounts-empty) | 桌面 1024×768 | 0 | [截图](desktop-short-accounts-empty.jpg) |
| [扫描进行中](http://127.0.0.1:4173/#/preview/scan-running) | 桌面 1024×768 | 0 | [截图](desktop-short-scan-running.jpg) |
| [未发现音乐](http://127.0.0.1:4173/#/preview/scan-empty) | 桌面 1024×768 | 0 | [截图](desktop-short-scan-empty.jpg) |
| [无法启动扫描](http://127.0.0.1:4173/#/preview/scan-failed) | 桌面 1024×768 | 0 | [截图](desktop-short-scan-failed.jpg) |
| [扫描中断](http://127.0.0.1:4173/#/preview/scan-interrupted) | 桌面 1024×768 | 0 | [截图](desktop-short-scan-interrupted.jpg) |
| [目录不可访问](http://127.0.0.1:4173/#/preview/directory-unavailable) | 桌面 1024×768 | 0 | [截图](desktop-short-directory-unavailable.jpg) |
| [没有搜索结果](http://127.0.0.1:4173/#/preview/search-empty) | 桌面 1024×768 | 0 | [截图](desktop-short-search-empty.jpg) |
| [没有专辑](http://127.0.0.1:4173/#/preview/albums-empty) | 桌面 1024×768 | 0 | [截图](desktop-short-albums-empty.jpg) |
| [没有艺人](http://127.0.0.1:4173/#/preview/artists-empty) | 桌面 1024×768 | 0 | [截图](desktop-short-artists-empty.jpg) |
| [列表载入失败](http://127.0.0.1:4173/#/preview/list-error) | 桌面 1024×768 | 0 | [截图](desktop-short-list-error.jpg) |
| [详情载入失败](http://127.0.0.1:4173/#/preview/detail-error) | 桌面 1024×768 | 0 | [截图](desktop-short-detail-error.jpg) |
| [页面不存在](http://127.0.0.1:4173/#/preview/not-found) | 桌面 1024×768 | 0 | [截图](desktop-short-not-found.jpg) |
| [初次设置](http://127.0.0.1:4173/#/preview/setup-empty) | 手机 393×667 | 0 | [截图](mobile-short-setup-empty.jpg) |
| [曲库为空](http://127.0.0.1:4173/#/preview/library-empty) | 手机 393×667 | 0 | [截图](mobile-short-library-empty.jpg) |
| [账号列表载入中](http://127.0.0.1:4173/#/preview/accounts-loading) | 手机 393×667 | 179 | [截图](mobile-short-accounts-loading.jpg) |
| [账号列表载入失败](http://127.0.0.1:4173/#/preview/accounts-error) | 手机 393×667 | 179 | [截图](mobile-short-accounts-error.jpg) |
| [账号搜索无结果](http://127.0.0.1:4173/#/preview/accounts-empty) | 手机 393×667 | 179 | [截图](mobile-short-accounts-empty.jpg) |
| [扫描进行中](http://127.0.0.1:4173/#/preview/scan-running) | 手机 393×667 | 0 | [截图](mobile-short-scan-running.jpg) |
| [未发现音乐](http://127.0.0.1:4173/#/preview/scan-empty) | 手机 393×667 | 0 | [截图](mobile-short-scan-empty.jpg) |
| [无法启动扫描](http://127.0.0.1:4173/#/preview/scan-failed) | 手机 393×667 | 0 | [截图](mobile-short-scan-failed.jpg) |
| [扫描中断](http://127.0.0.1:4173/#/preview/scan-interrupted) | 手机 393×667 | 0 | [截图](mobile-short-scan-interrupted.jpg) |
| [目录不可访问](http://127.0.0.1:4173/#/preview/directory-unavailable) | 手机 393×667 | 0 | [截图](mobile-short-directory-unavailable.jpg) |
| [没有搜索结果](http://127.0.0.1:4173/#/preview/search-empty) | 手机 393×667 | 0 | [截图](mobile-short-search-empty.jpg) |
| [没有专辑](http://127.0.0.1:4173/#/preview/albums-empty) | 手机 393×667 | 0 | [截图](mobile-short-albums-empty.jpg) |
| [没有艺人](http://127.0.0.1:4173/#/preview/artists-empty) | 手机 393×667 | 0 | [截图](mobile-short-artists-empty.jpg) |
| [列表载入失败](http://127.0.0.1:4173/#/preview/list-error) | 手机 393×667 | 0 | [截图](mobile-short-list-error.jpg) |
| [详情载入失败](http://127.0.0.1:4173/#/preview/detail-error) | 手机 393×667 | 0 | [截图](mobile-short-detail-error.jpg) |
| [页面不存在](http://127.0.0.1:4173/#/preview/not-found) | 手机 393×667 | 0 | [截图](mobile-short-not-found.jpg) |
| [FLAC 格式筛选无结果](http://127.0.0.1:4173/#/songs) | 手机 393×667 | 0 | [截图](mobile-short-actual-songs-empty.jpg) |
| [FLAC 格式筛选无结果](http://127.0.0.1:4173/#/songs) | 手机 393×852 | 0 | [截图](mobile-actual-songs-empty.jpg) |
| [FLAC 格式筛选无结果](http://127.0.0.1:4173/#/songs) | 桌面 1108×879 | 0 | [截图](desktop-actual-songs-empty.jpg) |
| [曲库载入中](http://127.0.0.1:4173/#/loading) | 桌面 1108×879 | 0 | [截图](desktop-actual-loading.jpg) |
| [曲库读取异常](http://127.0.0.1:4173/#/error) | 桌面 1108×879 | 0 | [截图](desktop-actual-error.jpg) |
| [目录不可访问正式入口](http://127.0.0.1:4173/#/directory-unavailable) | 桌面 1108×879 | 0 | [截图](desktop-actual-directory.jpg) |
| [初次设置正式入口](http://127.0.0.1:4173/#/setup) | 桌面 1108×879 | 0 | [截图](desktop-actual-setup.jpg) |
| [搜索无结果正式入口](http://127.0.0.1:4173/#/search?q=zzzz-no-match) | 桌面 1108×879 | 0 | [截图](desktop-actual-search.jpg) |
| [还没有歌单](http://127.0.0.1:4173/#/preview/playlists-empty) | 桌面 1108×879 | 0 | [截图](desktop-playlists-empty.jpg) |
| [歌单没有歌曲](http://127.0.0.1:4173/#/preview/playlist-empty) | 桌面 1108×879 | 0 | [截图](desktop-playlist-empty.jpg) |
| [还没有收藏](http://127.0.0.1:4173/#/preview/favorites-empty) | 桌面 1108×879 | 0 | [截图](desktop-favorites-empty.jpg) |
| [曲库载入中](http://127.0.0.1:4173/#/loading) | 手机 393×852 | 0 | [截图](mobile-actual-loading.jpg) |
| [曲库读取异常](http://127.0.0.1:4173/#/error) | 手机 393×852 | 0 | [截图](mobile-actual-error.jpg) |
| [目录不可访问正式入口](http://127.0.0.1:4173/#/directory-unavailable) | 手机 393×852 | 0 | [截图](mobile-actual-directory.jpg) |
| [初次设置正式入口](http://127.0.0.1:4173/#/setup) | 手机 393×852 | 0 | [截图](mobile-actual-setup.jpg) |
| [搜索无结果正式入口](http://127.0.0.1:4173/#/search?q=zzzz-no-match) | 手机 393×852 | 0 | [截图](mobile-actual-search.jpg) |
| [还没有歌单](http://127.0.0.1:4173/#/preview/playlists-empty) | 手机 393×852 | 0 | [截图](mobile-playlists-empty.jpg) |
| [歌单没有歌曲](http://127.0.0.1:4173/#/preview/playlist-empty) | 手机 393×852 | 0 | [截图](mobile-playlist-empty.jpg) |
| [还没有收藏](http://127.0.0.1:4173/#/preview/favorites-empty) | 手机 393×852 | 0 | [截图](mobile-favorites-empty.jpg) |
| [还没有歌单](http://127.0.0.1:4173/#/preview/playlists-empty) | 手机 393×667 | 0 | [截图](mobile-short-playlists-empty.jpg) |
| [歌单没有歌曲](http://127.0.0.1:4173/#/preview/playlist-empty) | 手机 393×667 | 0 | [截图](mobile-short-playlist-empty.jpg) |
| [还没有收藏](http://127.0.0.1:4173/#/preview/favorites-empty) | 手机 393×667 | 0 | [截图](mobile-short-favorites-empty.jpg) |

原始数据：[measurements.json](measurements.json)。账号矮屏滚动后：[操作可达截图](mobile-short-accounts-error-scrolled.jpg)。

## 构建检查

- npm run typecheck：通过。
- npm run build：通过。
- npm run prototype:build：通过（原型保留现有的大包体积提示）。
- git diff --check：通过。

UI 改动，未新增依赖或测试；运行了浏览器尺寸与恢复交互验证。
