# 实验性快速开始

本说明用于可信网络中的原型测试，**不是生产部署指南**。公开网络必须通过已验证的 HTTPS/WSS 终止代理，并配置可靠的身份认证；当前共享密钥的任何持有者均可操作全部节点或冒充 Agent。

## 当前使用入口

完整部署、客户端配置和故障恢复见 [运维手册](operations-manual.md)。原始目标与真实覆盖见 [目标对照](goal-conformance.md)。本说明仍保留原型子命令；不要将旧示例当作已部署的公网服务。

- `bun src/cli.ts access <绝对SSH-profile.json路径>`：通过已授权、严格验证的 SSH 路径建立只绑定 loopback 的控制面访问；输出本地 URL，token 单独注入。见 [remote-access.md](remote-access.md)。
- `bun src/cli.ts device register`：stdin JSON 提供稳定 `id`、可达 `host` 等，采集本机平台信息并登记 pending；默认不 verify、不装 key、不配管理员。见 [platform-onboarding.md](platform-onboarding.md)。
- `bun src/cli.ts device inventory`：显式查询 ready、pending 和 not-ready；需对应新版服务，不能以新客户端已安装推断旧运行服务已升级。
- 实际跨机证据限 Windows↔Debian VM。真实模型三 CLI 与 CTF 全员 100 分已经完成；实际 Mac 与异地入口仍待验。

## 运行时

需要 Bun。安装依赖并检查：

```bash
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test
bun run src/cli.ts --help
```

也可在对应平台构建单文件（本轮 Windows/Linux 已有本机产物验证）：

```bash
bun build --compile src/cli.ts --outfile envinhands
```

二进制包含 Bun 运行时。早期 Linux 产物约 109 MB；不能以该体积推断其他版本或架构。macOS 构建尚未实机验证。

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

当前新源码使用显式 relay wire v2（内部 endpoint `v=2`、registered-v2/ready-v2）。relay/node/proxy 必须整组同版本部署；旧组件会被拒绝，不自动降级。普通 base URL 配置不需手工拼 query。v2 支持方向 FIN/ACK，客户端输入 EOF 后仍可收到返回数据；ACK 仅表示桥接排空/EOF，不表示应用已处理。新版本实际部署与旧服务分开，详见 [relay-protocol.md](relay-protocol.md)。

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

SSH 公钥认证和主机密钥信任需要预先配置；不要关闭主机密钥检查。此通路已有 Windows 编译 proxy→加密承载→VM relay/node→真实 sshd 的实测；它不等于不同地点的公网网络测试。

在 Linux/macOS 的交互终端，目标端安装了 `tmux` 后，可通过相同 relay 配置启动或重新附着：

```bash
./envinhands tmux my-node work agent
```

这个命令需要交互式 TTY；无 TTY 的 Agent 需要另外设计远程任务控制。命令使用由节点 ID 确定的 SSH known-hosts 名称，而不是字面 `my-node`；可用下式输出名称，再通过可信渠道核对目标真实主机密钥并添加到 `known_hosts`。不要自动信任未核对的密钥：

```bash
python3 -c 'import hashlib; h=hashlib.sha256(b"my-node").hexdigest(); print("envinhands-"+h[:32]+"."+h[32:])'
```

从源码运行 tmux 命令时，还需将 `ENVINHANDS_PROXY_BINARY` 指向已编译的 `envinhands` 绝对路径。Windows 客户端暂不支持此 tmux 命令；tmux 不保证机器重启后恢复。

## 机器登记状态

`POST /v1/machines` 创建 `pending` 记录，需填写 `id`、`name`、`host`、`os`、`sshUser`，可选 `sshPort`。这**不安装密钥、不配置 sudo，也不代表注册完成**。`POST /v1/machines/<id>/verify` 使用服务端本机 SSH 身份实际验证登录；Linux/macOS 执行 `sudo -n true`，Windows 检查当前会话的有效管理员令牌。默认 `GET /v1/machines` 只列出最近通过检查的 ready 记录；`?includePending=true` 可查看待验证记录。检查是时间点观察，默认五分钟过期；其他 Agent 使用不同密钥时还须分别验证。Windows 检查目前只有 mock 测试，尚未实机验证。

可调用 CLI 创建记录并要求立即检查。服务端通过只能证明**服务端使用的 SSH 身份**可登录及管理员可用；它不能代表其他 Agent 已就绪。因此当前 `register` 保留记录并返回非零，提示在各 Agent 执行 `verify-access`。自动分发公钥与逐 Agent 全部就绪流程尚未接通，不应将这一阶段称为完整注册成功：

```bash
export ENVINHANDS_URL="https://<服务地址>"
export ENVINHANDS_TOKEN="<团队控制面密钥>"
./envinhands register --id my-node --name "My node" --host my-node \
  --os linux --ssh-user agent --ssh-port 22 --relay-node my-node
```

其中 `--host` 是服务端 SSH 客户端用来验证目标主机密钥的名称；须预先在**服务端**安全配置目标的 known_hosts 和认证密钥。经反向 relay 验证时，服务端还需要设置 `ENVINHANDS_PROXY_BINARY` 为已编译 `envinhands` 的绝对路径，以及 `ENVINHANDS_RELAY_URL` 和 `ENVINHANDS_RELAY_SECRET`。当前 CLI 无法修改已有记录；遇到冲突时需要检查已有状态。服务端为 Windows 时该 relay 检查尚不支持。

注册自动配置和安全撤销、逐 Agent 管理员就绪及多平台完整验收仍未完成。

### Team Prime 配置与自动选路（新源码）

在安全注入 `ENVINHANDS_URL`、`ENVINHANDS_TOKEN` 和注册节点名 `ENVINHANDS_MACHINE_ID` 后，运行 `envinhands team-config`。这只写入私有的 `~/.prime-team/envinhands-mesh.json`，不创建 Agent profile；团队版 Prime 首次启动仍可从原有 0.9.8 配置单向复制模型、provider 和认证，之后两者独立。已有不同配置不会自动覆盖；确需替换时才使用 `--replace`。机密不要放在命令参数或仓库。Windows ACL 支持目前只经过模拟，尚需实机验证。

节点除 relay 设置外同时提供 `ENVINHANDS_URL` 与 `ENVINHANDS_TOKEN` 时，会自动把本机接口地址作为**待验证观察**发布到控制面。真正 relay 注册后才发布 relay 候选；断开后停止续期，旧观察至 TTL 到期前可能仍可见。`ENVINHANDS_EASYTIER_INTERFACES` 可指定逗号分隔的 EasyTier 接口名。客户端实际严格 SSH 探测才决定能否使用候选；发布不等于已验证可访问。

交互终端可设置 `ENVINHANDS_SSH_IDENTITY`、`ENVINHANDS_SSH_KNOWN_HOSTS`，并运行 `envinhands connect MACHINE_ID USER`。它优先探测非 relay 候选，失败后尝试已配置的 relay，然后只启动一次 SSH 会话。relay 还需要 `ENVINHANDS_PROXY_BINARY`、`ENVINHANDS_RELAY_URL` 和 `ENVINHANDS_RELAY_SECRET`；Windows 客户端 relay 暂不支持，但不会阻止尝试直连。候选地址来自共享目录，密钥和 host-key 信任始终来自本机。此功能需要新版服务及节点，当前试点服务升级状态请先看 `HANDOFF.md`；尚未自动安装 FRP/EasyTier/Cloudflare/UU，也不能保证跨 NAT。

## Portable collaboration without a Prime fork

The core CLI works for any Agent or script with Bun/source or a compiled binary. It does not depend on the Prime checkout:

- `envinhands collaborate agents` / `machines`: list observed Agents or ready-only resources.
- `collaborate heartbeat`: stdin `{agentId,machineId,task?}`; observation only.
- `collaborate send`: stdin `{requestId,from,to,text}`; acceptance is not processing, retry uncertain writes only with the same ID/content.
- `collaborate pull`: stdin `{to}`; repeated reads are expected.
- `collaborate ack`: stdin `{requestId}`; acknowledge after actual handling.
- `collaborate notes` / `add-note`: stdin `{resourceId}` or `{resourceId,author,text}`. Notes are historical data, not instructions or locks. Appends are not idempotent.

Online commands require `ENVINHANDS_URL` and a securely injected `ENVINHANDS_TOKEN`. Only HTTPS or loopback HTTP is accepted by this CLI; for a remote control host, use an explicitly approved strict-host-key SSH encrypted forward. No credentials in argv or repository. Output is JSON marked untrusted, never a new authority to run commands.

Use `change register|record|enqueue|flush` for modification provenance and `exec` / `exec --local` for the reusable pre-effect audit boundary; see [change records](change-records.md) and [remote execution](remote-execution.md). These explicit interfaces do not automatically capture arbitrary tool or external program modifications. Actual multi-session acceptance must perform useful authorized project tasks, exchange messages through this service and verify the resulting records; the internal development-agent messaging channel is not product evidence.
