# 专辑补充信息部署 · 2026-09-28

> 隐私说明：环境地址和路径已替换为示例；原始验收附件在仓库外私有保存，不随仓库发布。

- 正式地址：http://192.0.2.10:3002/#/albums
- 镜像：`music-library:2026-09-28-album-metadata`
- 镜像 ID：`sha256:15e1fd71470c8fdb9b00632bf3d7ea1a5d2d7ef7c807816408cab1aae80b0594`
- 源码归档 SHA-256：`34b8c12d0ff73449d40fd4465f9eae84cb3746966dc5c1eeb2336f36ac548e8c`
- 页面资源：`index-2hx8so-P.js`、`index-COiEbc7a.css`
- 部署前镜像：`music-library:2026-09-28-playback-replay`，保留供回退。
- 部署资料：`/srv/music-library/releases/2026-09-28-album-metadata`。

## 备份与发布验证

停服务后完成完整数据备份，共 867 个文件，逐项验证大小与 SHA-256。备份位置：

`/srv/music-library/data-nas/backups/backup-2026-09-28T09-14-10.760Z-d6d6c750-218a-497e-a5cc-e14864b027ca`

部署前后数据指纹相同；新增补充信息表为空。仅重建 music-library 容器，其他容器未变化。容器健康、重启计数 0，音乐挂载 `/music` 保持 `RW=false`。

## 扫描验证

升级后执行普通扫描（未开启 prune、未开启在线补全），旧版本缓存重新解析：

- 共 1,045 首歌曲、11 张专辑，解析 1,045 个文件，零错误。
- 兼容 Vorbis YEAR 后，379 首歌曲补回年份；已有年份没有改变。
- 源标签索引除年份和更新时间外均保持一致；收藏、歌单、成员顺序的哈希保持一致。
- 未知年份从 828 首降至 449 首；实际缺失的文件仍保持未知，可由管理员填写。
- 数据库 quick_check 为 `ok`。

详细结果见 `rescan.verification.json`。正式浏览器已验证“补充专辑信息”表单可读取所选专辑的扫描值，截图见 `../../qa/album-metadata-2026-09-28/deployed-dialog.png`。保存、刷新、恢复与移动布局在独立本地测试库验证，没有向正式曲库写入测试信息。

## 验证命令

`npm run typecheck`、`npm test`（31 文件 / 475 测试）、`npm run build`、`git diff --check` 全部通过。
