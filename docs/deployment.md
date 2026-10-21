## TL;DR

在 Docker 主机运行门户，将一个域名代理到门户端口，房间使用 `/rooms/{code}/` 路径。

## Details

| 前提 | 要求 |
| --- | --- |
| 主机 | Linux、Docker、Node.js 24、npm、Git |
| DNS | `app.boxlite.ai` 指向主机 |
| TLS | 覆盖 `app.boxlite.ai` 的站点证书 |
| 入口 | 仅公开反向代理的 HTTPS 端口；3000 和编辑器端口留在回环地址 |

## 安装

```sh
sudo mkdir -p /opt/codingbox
sudo chown "$USER" /opt/codingbox
git clone --recurse-submodules https://github.com/DefeatMan/codingbox.git /opt/codingbox
cd /opt/codingbox
npm ci --omit=dev
npm run image:build
cp .env.example .env
chmod 600 .env
```

将 `.env` 改为：

```dotenv
PUBLIC_URL=https://app.boxlite.ai
HOST=127.0.0.1
PORT=3000
ADMIN_PASSWORD=填写至少12位的独立随机密码
DATA_DIR=/opt/codingbox/.data
WEDE_IMAGE=codingbox-wede:local
MAX_ACTIVE_ROOMS=5
ROOM_MEMORY=1g
ROOM_CPUS=1
```

运行门户的账户需要访问 Docker daemon。该账户等同于拥有主机管理权限；门户应仅管理专用面试主机。

复制 [codingbox.service](../deploy/codingbox.service) 到 `/etc/systemd/system/`，把 `User`、`Group` 改为实际运行账户：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now codingbox
sudo systemctl status codingbox
```

## HTTPS 入口

使用现有 Nginx 时，参考 [nginx.conf](../deploy/nginx.conf)。保留原始 `Host`、传递 `X-Forwarded-Proto`，并启用 WebSocket Upgrade。

该示例使用独立证书文件；替换为真实证书路径，验证配置后按你现有服务的流程 reload。仓库不修改线上 Nginx 或 DNS。

```sh
sudo nginx -t
```

可选 Caddy 示例：

```caddyfile
https://app.boxlite.ai {
  tls /etc/codingbox/tls/fullchain.pem /etc/codingbox/tls/privkey.pem
  reverse_proxy 127.0.0.1:3000
}
```

前置代理应限制请求体大小；应用自身限制门户 JSON 为 8 KiB。不要将 WEDE 的宿主机端口直接公开。

## 检查

1. 打开门户，登录并创建房间。
2. 在两个浏览器会话中凭同一码加入，确认免 IDE 二次登录。
3. 打开同一文件，双方分别输入，确认同步和语言补全。
4. 结束房间后刷新编辑器，确认访问被拒绝；下载代码包。
5. 重启门户，确认未结束房间可继续加入。

日志：`journalctl -u codingbox -f`。健康检查：`curl http://127.0.0.1:3000/healthz`。

## 数据与清理

| 数据 | 位置 / 策略 |
| --- | --- |
| 房间、会话、实例密码 | `.data/codingbox.sqlite`；目录仅运行账户可读 |
| 面试源码、WEDE 状态 | 命名卷 `codingbox-<房间 UUID>` |
| 结束后的容器 | 自动移除 |
| 结束后的数据卷 | 保留，不自动删除 |

优先通过门户下载已结束房间的代码。数据库备份使用 SQLite online backup，或先停门户再复制整个 `.data`；同时备份需要保留的 Docker 卷。

人工清理特定已结束房间：

```sh
# 先确认已结束并已导出；不要执行全局 volume prune。
docker volume inspect codingbox-替换为房间UUID
docker volume rm codingbox-替换为房间UUID
```

删除数据卷后，门户中的历史元数据仍保留，但该场代码将无法再次下载。

## 故障定位

| 现象 | 检查 |
| --- | --- |
| 创建失败 | `docker info`、镜像是否构建；在控制台结束错误房间后重试 |
| 房间打不开 | `/rooms/{code}/` 路径是否原样转发、房间是否有效、WebSocket 是否允许升级 |
| WebSocket 失败 | Upgrade 头、HTTPS 协议头、代理超时 |
| Docker Hub 401 | 修复本机 registry 登录；不要将个人 registry 凭证提交到仓库 |
| 无法结束 | Docker daemon 是否可用；恢复后再次点击结束 |
| 文件与终端内容不同 | 上游外部磁盘同步限制；避免从终端改已打开文件 |
