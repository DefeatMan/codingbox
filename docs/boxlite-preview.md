## TL;DR

BoxLite 预览使用 Linux native 模式，通过一个端口 tunnel 暴露门户和所有面试房间。

## Details

| 项目 | 预览配置 |
| --- | --- |
| Box | `codingbox-dev`，Node 镜像，2 CPU / 4 GiB / 10 GiB |
| 门户 | 监听 3000，`PUBLIC_URL` 使用该端口的 tunnel URL |
| 编辑器 | 监听回环端口 9000 起 |
| 房间入口 | 门户同域名 `/rooms/{code}/`，无需单独注册端口 |
| 并发 | `MAX_ACTIVE_ROOMS=5` |
| 生命周期 | `autoResume=true`，关闭页面后空闲 5 分钟停止 |
| 隔离 | 每房间独立非 sudo 用户、0700 私有目录；CPU/内存由整个 Box 限制 |

该模式是为没有 Docker daemon 的精简云 Box 提供的预览方式。默认部署仍使用 Docker。

## 配置示例

```dotenv
RUNTIME=native
WEDE_BINARY=/opt/codingbox/bin/wede
PUBLIC_URL=https://YOUR-PORT-3000-TUNNEL-HOST
HOST=0.0.0.0
PORT=3000
MAX_ACTIVE_ROOMS=5
DATA_DIR=/opt/codingbox/.data
ADMIN_PASSWORD=为这份预览单独生成随机密码
```

`PUBLIC_URL` 使用 `boxlite network tunnel codingbox-dev 3000` 实际返回的完整 HTTPS URL。

运行门户的账户需要免交互 sudo。原生运行器为每场创建 `cb<UUID前缀>` 系统用户、私有 home 和语言环境配置；编辑器进程不继承门户密码或云凭证。

依赖：补丁后的 Linux WEDE、Python/pylsp、Node/TypeScript/tsx、Go/gopls、g++/clangd、Rust/rust-analyzer。

Rust 使用 [安装脚本](../docker/install-rust.sh)，工具链位于 `/opt/rust/bin`。终端登录 Shell 的 `.bash_profile` 必须保留 [NativeRuntime](../src/native-runtime.ts) 中的 PATH。

有效面试码就是房间入场凭据；浏览器状态按房间区分，同一浏览器可打开多个房间。终端默认在底部展开；服务端同步终端增删与命名。完整协作状态保存在项目的 `.wede/collab`，重连后保持相同文档标识。

## Tunnel

```sh
boxlite network tunnel codingbox-dev 3000
```

只需注册门户的 3000 端口一次。创建房间后自动使用同一入口的 `/rooms/{code}/`；内部 WEDE 端口不对外暴露。旧版 `ROOM_URL_TEMPLATE` 和 `ROOM_PORT_OFFSET` 已移除，升级时从 `.env` 删除。

## 启动和恢复

源码位于 Box 的 `/opt/codingbox`。首次安装启动钩子：

```sh
cd /opt/codingbox
sudo python3 deploy/install-boxlite-boot.py
sh deploy/boxlite-boot.sh
```

启动脚本使用文件锁防止重复实例，并在门户退出后重启。镜像 entrypoint 在 Box 冷启动时调用它。

通过 CLI 后台启动首次预览：

```sh
boxlite exec --detach codingbox-dev -- sh /opt/codingbox/deploy/boxlite-boot.sh
```

访问 tunnel 会唤醒 Box，启动钩子随后恢复门户和未到期的房间。原生运行器从保留的配置恢复编辑器，不复制模板；过期房间按正常规则结束。

页面中的 WebSocket 活动会保持 Box 活跃。关闭页面后，空闲 5 分钟自动停止；也可运行 `boxlite stop codingbox-dev` 立即停止。

面试内的语言选择保存在项目 `.wede/interview-language.json`。初始项目保留在根目录，其他语言位于 `languages/<language>`；切换不会覆盖已有文件。

## 数据与访问

- 门户密码在 Box 的 `/opt/codingbox/.env`，权限 0600；dev 部署的独立密码保存在本地 `.data/dev-preview.env`，已被 Git 忽略。
- `.data` 保存 SQLite、native 元数据和日志，权限 0700。
- 源码在 `/srv/codingbox-rooms/<UUID>/project`，结束后保留。
- 用户和 UID 随归档保留。通过「已完成」删除记录时，会清理对应代码、元数据和系统用户；下载期间暂不能删除。
- 候选人有该用户的 Shell；该模式不提供每房间网络、资源或内核隔离。
