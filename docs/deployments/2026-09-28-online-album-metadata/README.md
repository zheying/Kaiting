# 专辑信息自动补全部署 · 2026-09-28

> 隐私说明：环境地址和路径已替换为示例；原始验收附件在仓库外私有保存，不随仓库发布。

- 正式地址：http://192.0.2.10:3002/#/albums
- 镜像：`music-library:2026-09-28-online-album-metadata`
- 镜像 ID：`sha256:59c8aa97ae49278e5cbe1ce1004e86d9d6bb4649c30ccca1f503cc226de7a821`
- 源码归档 SHA-256：`0e2fc3f1017cfce39011f03883947805624941324dd859ed02d57c89479e1522`
- 前端资源：`index-BljnTrlC.js`、`index--6EWtD53.css`
- 上一镜像：`music-library:2026-09-28-album-metadata`，保留供回退。
- 发布资料：`/srv/music-library/releases/2026-09-28-online-album-metadata`。

## 配置

`ENABLE_ONLINE_METADATA=true`，`SCAN_ONLINE_METADATA=false`。启用按需在线查询，扫描仅读取本地信息。Compose 增加后一个环境变量的映射；NAS 卷定义和其他容器保持原样。

MusicBrainz 查询使用名称查找发行记录，再在服务端核对艺人、曲目数、碟数及已有年份。唯一匹配填入草稿；多版本保留选择。查询结果缓存于 DATA_DIR 数据库，不改源文件、不修改收藏、歌单或专辑身份。

## 备份及上线

停服务后完成完整数据备份，867 个文件逐项验证大小和 SHA-256：

`/srv/music-library/data-nas/backups/backup-2026-09-28T09-53-56.855Z-d02d01a2-fc99-45a7-b627-8b9c24cc7fd5`

发布前后数据指纹一致，包括歌曲、扫描记录、收藏、歌单、成员顺序和专辑补充表。数据库 quick_check 为 `ok`；仅重新创建 music-library，其他容器保持不变。容器 healthy、RestartCount=0，`/music` 仍为 `RW=false`。

发布脚本在失败时恢复原 `.env` 和 Compose 配置，再启动原镜像。原配置副本保存在本次 release 目录，未纳入源码或本地文档。

## 验证

`npm run typecheck`、`npm test`（32 文件 / 497 测试）、`npm run build`、`git diff --check` 通过。桌面、移动布局及真实来源的查询、填写、保存、刷新在独立测试库验证。

正式容器已验证 MusicBrainz 连接可用，网页可以为《黄金の国イーラ》查找发行信息。正式查询仅生成草稿；由管理员点击“保存信息”后生效。截图见 `../../qa/online-album-metadata-2026-09-28/deployed-lookup.png`。
