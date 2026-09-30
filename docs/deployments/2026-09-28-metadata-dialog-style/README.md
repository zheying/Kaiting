# 专辑信息弹窗样式统一 · 2026-09-28

> 隐私说明：环境地址和路径已替换为示例；原始验收附件在仓库外私有保存，不随仓库发布。

- 正式地址：http://192.0.2.10:3002/#/albums
- 调整文件：`src/client/room/AlbumMetadataForm.tsx`、`src/client/room/metadata.css`。
- 已与上一版本源码归档比较，发布只包含以上两个文件的差异。

## 界面调整

弹窗宽度从 520px 收至 480px，沿用标准弹窗的背景、圆角与外部留白。专辑摘要、发行信息、编辑项使用统一间距与细分隔线。发行版本改用一个选中标记，保留原生单选框的键盘和读屏语义；聚焦整行显示轮廓。

移除重复的“扫描值：暂无”，原扫描数据存在时仍显示；说明改为简短的无底色文字。恢复扫描信息移至底部，与取消、保存统一排列；保存按钮使用标准文字形式。保留来源链接、无结果、失败、部分结果及版本不确定等提示。

## 发布

- 镜像：`music-library:2026-09-28-metadata-dialog-style`
- 镜像 ID：`sha256:19b3ae56bb0288e9aa02939d8c8056b30aab6011494041f9ed0cdc530fc3406c`
- 源码归档 SHA-256：`3af01ad126c71c460d19125edd29e9ea35f6a34a53ff31225f421a5567912348`
- 前端资源：`index-Jmtznu2p.js`、`index-DQu-99se.css`
- 原镜像：`music-library:2026-09-28-metadata-entry-style`，保留供回退。
- 远端发布目录：`/srv/music-library/releases/2026-09-28-metadata-dialog-style`
- 数据备份：`/srv/music-library/data-nas/backups/backup-2026-09-28T11-46-54.332Z-a66bdb14-6bb5-4da4-976d-4118dfdd980a`，867 个文件的大小和 SHA-256 均验证通过。

发布前后数据指纹一致；数据库 quick_check 为 ok。music-library 健康、重启次数为 0，其他容器未变化，音乐卷保持只读。服务器逻辑与在线查询配置保持原样。

## 验证

- `npm run typecheck`、`npm run build`、`git diff --check` 通过。
- `tests/album-metadata-lookup.test.ts` 的 18 项测试通过。
- 独立测试库验证了恢复扫描信息、Space 键重新选择发行版本、年份校验和保存。
- 测试库查找成功时，1280×720 下弹窗高约 618px，无内部溢出；393×852 下高约 610px、操作按钮高 40px，无横纵溢出；320px 窄屏无横向溢出。
- 检查了初始状态和在线服务繁忙的错误布局。正式库只查询和查看草稿，未保存专辑数据。

截图：桌面（原始附件已转存私有验收资料）、手机（原始附件已转存私有验收资料）、正式系统（原始附件已转存私有验收资料）。
