# 播放重播修复部署记录

> 隐私说明：环境地址和路径已替换为示例；原始验收附件在仓库外私有保存，不随仓库发布。

日期：2026-09-28。部署目标：`192.0.2.10:3002`。

- 新镜像：`music-library:2026-09-28-playback-replay`
- 镜像 ID：`sha256:072a8b1cdeb9cfd0a9520845094e83783224182c17164d0add47f95b405603e3`
- 上一版本：`music-library:2026-09-28-audit-fixes`，保留用于回退。
- 源码归档 SHA-256：`8a1f5c856d1d4e345b79355d2073c0b20b354ea8d32c2841b941546fdceecec0`
- 客户端：`index-BE5kaePL.js`，样式保持 `index-CbFRmKY2.css`。
- 远端发布目录：`/srv/music-library/releases/2026-09-28-playback-replay`。

构建前通过类型检查、构建和 454 项测试。发布时确认没有运行中的扫描，停止音乐服务后创建备份并逐一验证 867 个文件的大小与 SHA-256。仅更新该服务的镜像，其他容器没有变化。

备份路径：

`/srv/music-library/data-nas/backups/backup-2026-09-28T08-24-33.930Z-f16f1872-0f71-41c2-b3fa-94eb5d02fa9f`

发布前后 `data.before.json`（原始附件已转存私有验收资料） 与 `data.after.json`（原始附件已转存私有验收资料） 完全一致：1045 首曲目、4 次扫描记录，数据库完整性为 ok，外键错误为 0。备份验证见 `backup.verification.json`（原始附件已转存私有验收资料）。

部署后容器为 running / healthy，RestartCount=0；`/api/health` 返回 `{"ok":true}`，`/music` 挂载 RW=false。正式浏览器加载新资源并完成用户所报曲目的重播验收，详见[验收记录](../../qa/playback-replay-2026-09-28/README.md)。

回退时将 `.env` 的 `MUSIC_LIBRARY_IMAGE` 恢复为 `music-library:2026-09-28-audit-fixes`，然后在 `/srv/music-library` 运行 `/usr/local/bin/docker compose up -d --no-build music-library`。本次未改变数据库结构。
