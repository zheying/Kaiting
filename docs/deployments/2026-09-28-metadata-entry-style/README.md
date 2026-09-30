# 专辑补充信息入口样式 · 2026-09-28

> 隐私说明：环境地址和路径已替换为示例；原始验收附件在仓库外私有保存，不随仓库发布。

- 正式地址：http://192.0.2.10:3002/#/albums
- 本次仅修改 `src/client/room/metadata.css`，已与上一发布源码归档逐文件比较。
- 桌面入口文字从 11px 调整至 10px，与年份相同；铅笔图标从 12px 调整至 11px。
- 统一辅助信息行的垂直对齐；移动端字号与年份保持 9px。点击高度保留桌面 30px、移动端 36px。
- 详情页入口及专辑信息弹窗样式保持原样。

## 发布

- 镜像：`music-library:2026-09-28-metadata-entry-style`
- 镜像 ID：`sha256:44e1706a0b28578f8ec89a12daed972adf2ff2fe3dd2f86d64e0268e2a95869a`
- 源码归档 SHA-256：`9641e06e930367124632c6087551dd2e32b01acaddbca5567dd728c3b88746a8`
- 前端资源：`index-B-UkHfOU.js`、`index-Cugjy0SI.css`
- 上一镜像：`music-library:2026-09-28-online-album-metadata`，保留供回退。
- 发布目录：`/srv/music-library/releases/2026-09-28-metadata-entry-style`
- 完整备份：`/srv/music-library/data-nas/backups/backup-2026-09-28T11-12-07.962Z-8b2c5c85-4364-4d5e-b51f-3b6ac3ccec55`，867 个文件逐项核验大小与 SHA-256。

容器 healthy、RestartCount=0。发布前后数据指纹一致，数据库 quick_check 为 ok。仅更新 music-library，其他容器保持不变，音乐目录仍以只读方式挂载。在线补充配置保持上一版本。

## 验证

`npm run typecheck`、`npm run build`、`git diff --check` 通过。纯 CSS 修改未新增测试。

正式网页 1300×879 下入口与年份均为 10px，文字行高均为 16px，各卡片辅助行中心对齐。入口可打开专辑补充弹窗。393×852 下入口与年份均为 9px，点击高度 36px，页面无横向溢出。临时窗口尺寸已恢复。

截图：桌面（原始附件已转存私有验收资料）、移动端（原始附件已转存私有验收资料）。
