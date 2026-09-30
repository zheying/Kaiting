# Docker / NFS 部署指南

本文仅使用示例主机和路径。实际 IP、SSH 账号、NAS 导出目录、密码和备份位置保存在部署主机或仓库外私有资料中，不提交版本库。

## 基础部署

在部署目录复制 `.env.example` 为 `.env`，填写初始管理员密码、随机 Cookie 密钥、音乐路径和数据路径。变量说明见 [README](../README.md#环境配置)。

```bash
docker compose up -d --build
docker compose ps
```

基础 [Compose 配置](../docker-compose.yml) 将主机音乐目录只读挂载到 `/music`，数据目录挂载到 `/data`，发布端口默认 `3000`。HTTPS 保持 `COOKIE_SECURE=true`；可信局域网 HTTP 直连显式设为 `false`。

首次登录后在设置中选择音乐目录，系统自动扫描。已有账号密码由账号页管理，修改 `.env` 中的 `ADMIN_PASSWORD` 不会覆盖它。

## 只读 NFS 卷

如果音乐存放在另一台 NAS，先确保 NFS 已导出目标目录，且应用主机具有只读访问权限。使用 [NFS 覆盖配置](../docker-compose.nfs.yml) 替换 `/music` 挂载，数据库仍放在应用主机本地磁盘上。

以下是创建卷的示例；先替换占位值，并根据 NAS 支持情况选择 NFS 参数：

```bash
NAS_HOST="nas.example.invalid"
NAS_EXPORT="/exports/music"
NAS_VOLUME="music-library-nas-music"

docker volume create \
  --driver local \
  --opt type=nfs \
  --opt "device=:${NAS_EXPORT}" \
  --opt "o=addr=${NAS_HOST},nfsvers=3,proto=tcp,nolock,ro" \
  "${NAS_VOLUME}"
```

已有同名卷时先核对配置，不删除或覆盖正在使用的卷。在部署用 `.env` 中填写对应的 `NAS_MUSIC_VOLUME`；基础文件在合并前仍会插值，`MUSIC_LIBRARY_PATH` 也必须非空。

```bash
docker compose -f docker-compose.yml -f docker-compose.nfs.yml up -d --build
```

也可把 NFS 配置复制为部署目录的 `docker-compose.override.yml` 自动加载。启动前在本机核对 `/music` 为预期只读卷、`/data` 为预期持久化目录；不要把展开后的 Compose 配置粘贴到公开日志，它可能包含凭据。

## 更新与维护

- 更新前停止服务并备份数据，步骤见 [数据维护与升级](../README.md#数据维护与升级)。保留可回退的镜像和数据备份，回退数据库时使用新目录。
- 更新时保留部署侧 `.env`、覆盖配置、音乐与数据路径；不要用开发机配置覆盖生产配置。
- `unless-stopped` 处理容器异常退出，健康检查失败本身不会触发自动重启。主机与 Docker 的启动、休眠及 NAS 挂载恢复应独立验证。
- 服务与维护命令不能同时占用同一个 `DATA_DIR`。备份工具不复制 `.env` 或音乐文件，密钥与部署配置另行私有保存。

## 公开资料边界

运行截图、网络日志、trace、扫描错误详情、数据库摘要和备份清单可能暴露主机地址、文件路径或会话。原始资料放在被 Git 忽略的 `artifacts/` 或仓库外私有目录，公开文档只保留脱敏说明。不要使用强制添加绕过忽略规则。
