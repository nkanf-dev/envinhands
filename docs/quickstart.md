# 实验性快速开始

本说明用于可信网络中的原型测试，**不是生产部署指南**。公开网络必须通过已验证的 HTTPS/WSS 终止代理，并配置可靠的身份认证；当前共享密钥的任何持有者均可操作全部节点或冒充 Agent。

## 运行时

需要 Bun。安装依赖并检查：

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run src/cli.ts --help
```

也可在对应平台构建单文件（目前仅本机 Linux 构建验证）：

```bash
bun build --compile src/cli.ts --outfile envinhands
```

二进制包含 Bun 运行时。本机 Linux 产物约 109 MB；其他系统的构建与体积尚未验证。

## 服务端

在三台机器都可连接到的主机上运行两个进程。不要把以下密钥写进仓库或命令行；安全保存密钥，重启时复用：

```bash
export ENVINHANDS_TOKEN="<团队控制面密钥>"
export ENVINHANDS_DB="./envinhands.sqlite"
bun run src/cli.ts server
```

```bash
export ENVINHANDS_RELAY_SECRET="<团队中继密钥>"
bun run src/cli.ts relay
```

默认分别监听 `0.0.0.0:8787` 和 `0.0.0.0:8788`。可设置 `ENVINHANDS_HOST`/`ENVINHANDS_PORT` 与 `ENVINHANDS_RELAY_HOST`/`ENVINHANDS_RELAY_PORT`。两者现在均不提供内置 TLS。数据库文件由 `.gitignore` 排除，但仍应保护和备份。

## 节点与 SSH

在已启用 SSH Server 的目标机器上：

```bash
export ENVINHANDS_RELAY_URL="ws://<中继地址>:8788"
export ENVINHANDS_RELAY_SECRET="<团队中继密钥>"
export ENVINHANDS_SSH_PORT=22
bun run src/cli.ts node my-node
```

节点主动向中继出站连接，并将连接转发到本机 `127.0.0.1:$ENVINHANDS_SSH_PORT`。控制连接断开后会重试，但已有 SSH 会话不会无缝恢复。生产网络应使用配置好 TLS 的 `wss://`。

在发起连接的机器上，以绝对路径指定已构建的 `envinhands` 可执行文件：

```bash
export ENVINHANDS_RELAY_URL="ws://<中继地址>:8788"
export ENVINHANDS_RELAY_SECRET="<团队中继密钥>"
ssh -o 'ProxyCommand=/绝对路径/envinhands proxy my-node' 用户名@my-node
```

SSH 公钥认证和主机密钥信任需要预先配置；不要关闭主机密钥检查。此通路已在单机临时 sshd 上验证，不等同于跨网络实测。若 `tmux` 已安装，可通过现有会话命令构造组件重连；CLI 尚未直接封装 tmux 启动。

## 机器登记状态

`POST /v1/machines` 创建 `pending` 记录，需填写 `id`、`name`、`host`、`os`、`sshUser`，可选 `sshPort`。这**不安装密钥、不配置 sudo，也不代表注册完成**。`POST /v1/machines/<id>/verify` 使用服务端本机 SSH 身份实际验证公钥登录及 `sudo -n true`。默认 `GET /v1/machines` 只列出最近通过检查的 ready 记录；`?includePending=true` 可查看待验证记录。检查是时间点观察，默认五分钟过期；其他 Agent 使用不同密钥时还须分别验证。Windows 管理员验证尚未实现。

注册自动配置和安全撤销、管理员多平台验证、可靠多出口自动切换以及 Prime Agent 消息的自动注入均未完成。
