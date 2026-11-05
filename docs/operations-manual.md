# EnvInHands 运行与运维手册

> 本文是当前获准实现与实测范围的运行手册，不是“全部最终目标完成”证明。适用于已获准的团队资源。主控维护最终验收和阶段变更/回退记录；环境协调维护本文。命令中的 `<...>` 都是需填写的非敏感路径或标识，不可原样执行。任何安装、服务切换、配权和网络变更都须有对应授权。

## 1. 部署角色与已验证范围

最后功能源码为ba9a9d2（Windows221pass，精确Linux220pass1skip，types均0），正常完整Node Prime冷启动7Env扩展/2skills与两host读取/原操作核对已通过。当前资源服务源码为2801896，最新pure-client模型提取未改变服务wire，不能把仓库HEAD当运行部署。工作区handoffs/12-current-runtime-manifest.json列真实PID、版本、私有config引用和owned释放边界，不含token。最终范围见 [验收报告](acceptance-report.md)，正常用户先按 [normal-workflow.md](normal-workflow.md) 操作。


- **控制主机**：当前为 Hyper-V `EnvInHands-Debian12`，Debian 12.15 amd64、4 vCPU、4 GiB RAM、64 GiB 动态盘。它就是当前控制主机，可用于已实现范围的最终集成验收，不必先换真实 NAS。
- **客户端**：Windows 上新建多个真正独立的 Prime Agent TS 0.9.8 系列实例，每个实例有独立进程、配置、工作目录、Agent ID、session、数据目录。现有开发会话只开发、部署和审查，不充当被测客户端。
- **节点**：在获准目标上运行出站 node，将 relay 字节流连接到本机已配置的 SSH 服务；不必为此在每个节点运行整个 Prime。
- **可选 Linux 客户端 VM**：实际需要时再创建。控制 VM 同时运行客户端不等于增加第二台主机；同一宿主的多个 VM/NAT 也不等于异地网络。

已经实测可用的范围包括：Windows↔Debian 控制 VM 的严格 SSH、加密转发后的真实 HTTP/SQLite、实际 relay/proxy→sshd、SSH 候选探测与新连接回退、实际 Unix tmux 正常 detach/reconnect 保留同 PID，以及三个真实 Prime CLI 的产品协作。scriptprovider 的真实 Agent loop 与真实模型验收必须分别报告；模型 API 200 不单独证明全部任务完成。最终模型和 CTF 全员参与的结果以主控最新验收报告为准，不在此提前写成通过。

当前服务使用共享 bearer/relay secret。声明署名不是强身份认证；团队内部不新增权限分层、资源隔离或独占锁。不能因此省略 SSH host key、凭据保护和网络加密。

## 2. 交接清单与目录约定

每次部署保存以下清单，放在受控运维资料目录，不将凭据写进 Git：

| 内容 | 需保存的信息 |
|---|---|
| 源码 | 完整 commit、源码包 SHA-256、逐文件路径/大小/hash、未提交改动是否包含、替代哪个版本 |
| 运行时 | 平台/架构、版本、官方下载地址、发布 checksum、实际二进制 hash、绝对路径 |
| 服务 | 服务用途、绑定地址/端口、真实 PID/监督器标识、启动入口、配置文件**引用**、数据库路径、退出/清理方法 |
| 客户端 | Agent/machine/session 标识、独立 workdir/data/spool、实际程序来源、SSH 身份引用，不含私钥内容 |
| 验证 | 实际命令、完整原始输出、exit_code、首失败、负控、覆盖层级和限制 |
| 修改记录 | 注册信息引用、执行和目标机器、资源、授权、时间、结果与前后 hash（可得时） |

建议分开 `releases/<commit>/`、`runtimes/`、`private/`、`data/`、`backups/` 和 `evidence/`。私有目录 Unix 权限 `0700`，secret 配置 `0600`；Windows 使用仅授权账户可读的 ACL，不能把 POSIX mode 当成 ACL 证明。目录名是约定，不是项目自动创建的安装体系。

当前验收使用的是独立、用户目录中的 **临时受控 fixture**，没有安装成常驻系统服务、设置开机启动或完成生产 TLS 部署。活跃 fixture 的 PID、URL、配置和数据库以主控持有的受限部署清单为准，不把本手册中的示例当成当前实时状态。运行期间不要覆盖源码、删配置或清库。

## 3. 最小依赖与便携运行时

### 3.1 EnvInHands

当前 TS 主路径需要 Bun；本轮 Windows 与 Debian VM 验证使用 **Bun 1.4.4**。Bun 内置 SQLite，无需额外 SQLite 服务、Node/npm、Rust、UU 或 rathole 才能运行 Env 核心服务。

1. 从官方版本发布下载与 OS/架构匹配的包及 checksum。
2. 下载失败保存首失败；不同网络/官方 API 通道可按明确方案调整，不静默换版本或跳过 hash。
3. 比对官方 SHA-256，检查压缩包路径、特殊文件和 symlink 边界，再解压至用户目录。
4. 运行绝对路径 `<bun> --version`，记录 exit 和版本。官方 HTTPS checksum 校验不等于已验证独立签名，证据写清。
5. 不改全局 PATH；需要子进程查找工具时，只改该进程的 PATH。

在选定的源码根目录：

```text
<absolute-bun> install --frozen-lockfile --ignore-scripts
<absolute-bun> run typecheck
<absolute-bun> test
```

锁文件及 manifest 安装前后必须一致；不要把 lock 变更当成安装必然步骤。`prime-fork` 测试可能因缺外部 Prime checkout 跳过，完整报告必须列 skip；它直接导入扩展，不替代真实 loader 或 CLI。设置合法的 `PRIME_AGENT_CHECKOUT` 可以测试相应外部源码，但不要指向无关安装版来掩盖版本差异。

可在授权的平台编译 CLI：

```text
<absolute-bun> build --compile src/cli.ts --outfile <own-absolute-output>
```

编译完成后记录二进制 hash 和实跑结果。Linux 本轮约 109 MB，不代表所有平台或后续版本的体积。编译产物包含运行时，不是永久安装或跨平台可执行文件。

### 3.2 Prime 验证客户端

本轮便携 Linux 验证运行时为官方 **Node v24.14.1 / bundled npm 11.11.0**；Windows 用实际安装并验证的 Node 24+。它们用于 Prime，不成为 Env 业务依赖。

Prime 源码应包含本轮 source loader 修复，采用其原 `package-lock.json`：在 Prime 根目录由 owner 执行 `npm ci --ignore-scripts`。使用该平台原生依赖，不复制 Windows `node_modules` 到 Linux，不用 Bun 改 npm lock。最小验证导出包必须保留源码布局、资源和依赖闭包；只有 `.mts` 入口不等于可搬运的 Prime。

Prime 规则见其 `AGENTS.md`：不要运行其 `npm run dev`、`npm run build` 或 `npm test`；代码检查和精确测试按 owner 规则执行。普通 Env 节点无需这些开发依赖。

### 3.3 SSH、Python 与 tmux

目标需有已获准的 OpenSSH Server；客户端需 OpenSSH Client。Python 3 用于本轮辅助/自建 CTF，不是替代 Bun 的项目实现。Prime 完整 CLI 可能预热 Python kernel：配置已兼容的真实 Python，关闭未经批准的自动安装；`--offline` 不自动阻止所有模型或 bootstrap 网络请求。

Unix tmux 可由管理员按批准安装，也可从官方 Debian 包核验后提取到独立用户 prefix。本轮使用 tmux 3.3a，复用系统 libc/libtinfo，用户态补入官方 libevent-core、libutempter 共享库；**没有提取或运行特权 utempter helper，没有 setuid/setgid 或系统安装**。仅该进程设置 `LD_LIBRARY_PATH=<prefix>/usr/lib/x86_64-linux-gnu`。此 Debian 包方案不能照搬 macOS。

## 4. 受信 SSH 与安全链路

### 4.1 首次信任

- 从本地控制台或其他已认证带外渠道核对目标 host key fingerprint，再写入该客户端受保护的 known_hosts。
- 不用 `StrictHostKeyChecking=no`、`accept-new` 或清空 known_hosts 来“修好”失败。`ssh-keyscan` 只能采集候选，不证明身份。
- 每个实际 Agent 用获准的身份和路径检查；不得上传私钥或管理员密码。密钥路径可引用，内容不能进入聊天、日志、源码或消息。
- IP 随 NAT/重启变化时先查询实际地址；地址变化不自动改变主机身份，key 变化须重新带外确认。

普通只读登录形态：

```text
ssh -i <identity-path> -o UserKnownHostsFile=<known-hosts-path> -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10 <user>@<host> "id -u && uname -s"
```

退出 0 证明该次登录/命令，不等于管理员 ready。Unix 单独执行 `sudo -n true`；当前控制 VM 此项失败，必须保留 `not-ready`。Windows 必须检查 SSH 会话**实际有效管理员令牌**，不是只看用户在 Administrators 组。

### 4.2 访问 loopback 控制面

在现有授权内选择空闲的客户端本地端口，建立只绑定 loopback 的加密转发：

```text
ssh -N -T -i <identity-path> -o UserKnownHostsFile=<known-hosts-path> -o StrictHostKeyChecking=yes -o BatchMode=yes -o ExitOnForwardFailure=yes -L 127.0.0.1:<local-port>:127.0.0.1:<server-port> <user>@<control-host>
```

不要用 `-g` 或 `0.0.0.0` 暴露转发。若本地端口竞争，失败后重新选择并记录，不覆盖其他监听。`ExitOnForwardFailure` 只证明转发设置成功；还要用受限 token 发实际 API 请求证明后端可达。等待真实进程/listener/API 信号，不靠固定 sleep 宣称 ready。

客户端的 `ENVINHANDS_URL` 指向 `http://127.0.0.1:<local-port>`。不要为了连接远程 VM 偷开 `ENVINHANDS_ALLOW_INSECURE_HTTP=1`；公网 HTTP/WS 必须有经验证的 HTTPS/WSS 或获准加密承载，不能直接公开 prototype。SSH 通道可用与目标 admin ready 分开记录。

Windows Git Bash 可能改写传给 SSH 的远程绝对路径或 named-pipe 反斜杠。优先使用 argv 直接启动的 OpenSSH/Node，远程命令从明确 `cd` 后运行。保留首失败，别把 shell 参数损坏当成项目功能失败，也别改 host key 校验绕过。

## 5. 控制服务的建立、运行和释放

### 5.1 选择部署版本

接收完整 commit 和源码 manifest，校验 archive hash、全部文件的大小/hash、路径边界及特殊成员。创建新用户目录解压，不覆盖上个版本或正在运行的源码。安装原锁、运行 typecheck 和相关测试，写本版本实际统计；早快照不证明后加功能。

服务绑定需显式设置：项目默认值可能是 `0.0.0.0`，本环境标准是 **127.0.0.1**。服务和 relay 无内置 TLS。控制面和 relay 是不同进程、不同 secret，不要将一个的就绪当另一个已运行。

### 5.2 源码 CLI 启动形态

先用获准的受限启动器把配置注入**进程环境**，不要将 secret 写在命令行、shell history、输出或 `.env` 提交文件中：

| 变量 | 控制面含义 |
|---|---|
| `ENVINHANDS_TOKEN` | 受保护的共享 bearer，重启复用原值，轮换须协调客户端 |
| `ENVINHANDS_HOST` | 本机验收显式 `127.0.0.1` |
| `ENVINHANDS_PORT` | 可控端口；CLI 接受 0 让 OS 选择随机端口 |
| `ENVINHANDS_DB` | 自有绝对 SQLite 路径，目录权限受限 |

随后从选定源码根运行：

```text
<absolute-bun> src/cli.ts server
```

CLI 不输出选中的随机端口；需要随机端口 handoff 时，采用显式调用 `startAgentBusServer({dbPath,token,hostname:"127.0.0.1",port:0})` 的受控启动器，读取它返回的 `url`。不要解析猜测或固定等待。

历史验收外部 fixture 的私有 JSON 是 `{url,token,dbPath}`，它不是所有 CLI 都能直接读取的标准服务配置。fixture 启动时新建 `0700` 目录、随机 token、`0600` 配置，输出非敏感 ready marker；正常退出会关闭 DB 并删除该配置，**不会替你永久保管 secret 或自动删 DB**。后续重启需要操作员另存受限凭据和原数据库，不能重跑“全新 fixture”后误称恢复原服务。新部署应使用正式 `service` 私有配置入口（见 service-deployment.md），不退出删除 config，已实际双OS进程复用 config/DB 重启。

### 5.3 就绪与在役约束

1. 记录真实 PID、启动入口/源码和数据库，核对监听是 loopback。
2. 从受限文件/环境读取 token，认证 `GET /v1/agents`、`/v1/machines`、`/v1/changes` 应返回 200；缺 token 应返回 401。不要打印 Authorization。
3. `GET /v1/agent-registrations` 不支持，405 不是服务故障；注册走 POST。接口按当前源码，不按目标 protocol 草案替换路径/状态。
4. 数据库文件存在不等于记录正确；对获准的具体记录做 API 或独立 readonly 连接核对，不随意浏览其他业务内容。
5. 服务供下游客户端使用时保持配置和数据，直到主控明确释放。启动命令已接受不是服务长期存活保证。

### 5.4 停止与更新

- 先暂停/协调自有新任务，核对精确 PID、exe/argv/cwd 或已登记监督器；SIGTERM 只发给本服务，等待实际退出码，再检查端口关闭。不要 `killall bun/node/ssh`。
- relay/node 也只关自有实例；node 控制连接结束不证明 SSH 子任务已经完成。
- 当前 fixture 退出删除 config，清理前先确认下游不再需要；DB、spool、客户端 session 证据不要随手删除。清理是修改，须署名记录。
- 更新在新目录预验，保持旧源码/凭据引用及一致性备份。经批准再停旧服务、启动新版本、恢复加密转发和做最小读写验证；记录每一步实际结果。不能把文件已替换写成运行中服务已升级。
- 运行中不得直接 hot-copy 新源码、覆盖 live SQLite、换 token 或重启来满足单项检查。当前没有已交付的系统服务管理器、自动升级或开机恢复承诺。

## 6. 设备登记、发现和逐客户端权限

### 6.1 只登记元数据

认证 `POST /v1/machines` 输入：

```json
{"id":"control-debian12","name":"EnvInHands Debian12","host":"CONTROL_HOST","os":"linux","sshUser":"debian","sshPort":22}
```

实际地址由部署清单提供，别把示例占位值登记成真实地址。新记录返回 **202 / pending**，不安装 SSH 公钥、不配置 sudo，也不证明注册目标体验已完成。当前控制 VM 已通过此 API 登记，独立同 DB readonly 连接读到提交；这是提交可见性，不是重启/掉电恢复演练。

- 409：先查询已有记录；不要自动重建、更新、verify 或重复 POST。当前 API 没有通用更新/删除机器接口。
- `GET /v1/machines` 默认仅返回未过期 ready；`?includePending=true` 加入 pending，仍不包括 not-ready。因此空列表不等于数据库无记录。
- `POST /v1/machines/<id>/verify` 无 body，使用**服务端**现有 SSH 身份；会影响状态，必须是明确的检查动作。不能据此推断全部客户端获权。
- 心跳记录观察，不续期管理员证据。验证默认五分钟时效，具体以当前配置/源码为准。

CLI `register` 会先创建再自动 verify；仅需元数据 pending 时不要误用它。CLI 返回失败也可能留下记录，不代表回滚。

### 6.2 每 Agent 实际验证

`verify-access` 从 stdin 读取实际 registration、targetMachineId、os、候选 routes、access、priority、总预算和 TTL，参见 [`remote-execution.md`](remote-execution.md) 与 `src/access-cli.ts`/`client-access.ts`。返回绑定 Agent/session/身份引用/路由/时间的本地证据；ready 退出 0，not-ready 退出 1。它不是服务器认证的防伪证明。

SSH 身份共享必须由所有者明确批准，不能把 Agent ID 不同当成私钥不同，也不能为演示自动复制私钥。当前 `sudo -n` 不足不阻止普通 readonly 任务，但必须阻止宣称 admin ready。

原 Linux TS/Rust 注册助手仍只生成计划，旧 apply 拒绝；现正式 provision 使用新增 Unix/Windows 原生 helper，显式确认应用与 owned 撤销已隔离测试，见第17节。真实系统未配权，不能据此说实际注册/admin通过。不要用临时改 sudoers 刷绿。没有用户授权与既有管理员引导入口时，报告需操作员处理，不绕过。

## 7. 独立 Prime 客户端配置与协作

### 7.1 每个实例的独立项

准备已修复并锁定依赖的 Prime 源，使用它的实际 CLI，不靠全局安装版。为 A/B/C 分别提供：

- 自有工作目录、`PRIME_AGENT_CODING_AGENT_DIR`、`--session-dir`、独立 daemon socket/pipe 和 session；该版本没有 `--agent-dir` 参数。
- 不同 `ENVINHANDS_AGENT_ID`，正确 `ENVINHANDS_MACHINE_ID`。同一 Windows 的多个实例可共享机器 ID，但不能伪称不同物理机器。
- `ENVINHANDS_URL`、安全注入的 `ENVINHANDS_TOKEN`、`ENVINHANDS_AUDIT_SIGNATURE`，单独的 `ENVINHANDS_CHANGE_SPOOL`。
- 如需执行资源任务，`ENVINHANDS_EXECUTION_PROFILES` 指向获准本地 profile，只含身份/known_hosts 路径引用与实际目标，不上传私钥。
- 原 workspace skills 或显式 skill 路径；skill 是操作说明，不是网络服务或授权。其他工作目录需要实际验证发现。

启动前注入配置，后 attach 视图不创建新身份。不要假设未设置变量能擦除常驻 daemon 的环境，也不要把继承相同 ID 的子 Agent 计作独立参与者。

### 7.2 显式加载扩展

推荐用 `<env-command> prime-profile <Env绝对根> <Prime绝对根>` 输出正常 opt-in settings 片段，合并到每个客户端自己的私有 settings.json；不覆盖已有配置。它同时列出七个扩展（含工具观察）及两个显式 skill 路径，即使客户端工作目录不同也可加载。不要再传 --no-skills/--no-extensions 将其禁用。配置前置与实际无模型 loader 验证见 [prime-profile.md](prime-profile.md)。生成片段不证明 required 环境已设置、服务已升级或 Agent 已注册。

根据任务加载绝对路径：Prime 原有 `envinhands-heartbeat.ts`、`envinhands-messages.ts`、`envinhands-resources.ts`，及 Env 的 `src/integrations/prime.ts`（记录）、`prime-execution.ts`（获准远端执行）、`prime-attribution.ts`（工具事件观察）。缺配置时可能不注册工具，应查看真实 loader/status，不直接调用付费模型试探。

真实 CLI 启动形态、Node+tsx、RPC、Python kernel 前置、实际 `agent_end` 与结束方法见 [`prime-cli-validation.md`](prime-cli-validation.md)。`scripts/verify-prime-clients.mts` 是真实 ExtensionRunner **前置**，不能替代完整 Agent CLI/runtime/session。

零成本 scriptprovider 与获准真实模型分开。模型只从操作员批准的 endpoint/API/model 与受限环境取得 key，不能把实际 key 写入 models.json、prompt、session 或报告。API key 配置可引用环境变量名；API 200 只证明该请求。RPC `prompt` 成功也仅是接受，要等实际 `agent_end` 和工具/结果证据。费用不能从默认 0 推断为免费，不自动将真实模型失败改成 fixture 通过。

### 7.3 实际产品协作与便携 CLI

普通 Agent/脚本可直接用本仓库，不必修改 Prime 平台：

```text
<env-command> collaborate agents
<env-command> collaborate machines
<env-command> collaborate heartbeat
<env-command> collaborate send
<env-command> collaborate pull
<env-command> collaborate ack
<env-command> collaborate notes
<env-command> collaborate add-note
```

其中 `<env-command>` 为 `<bun> src/cli.ts` 或已验证的编译 CLI；写入/选择资源等 JSON 通过 stdin，详见 [`quickstart.md`](quickstart.md)。不要以内部 `agent_message` 代替产品收发。

保持 requestId 稳定：消息新建 201、同 ID 同内容重试 200、冲突 409；pull 可重复、不认领；处理后显式 ack，HTTP ack **无 body**，路径用 requestId，不是不存在的 message.id。CLI ack 的 stdin `{requestId}` 是客户端输入，不是服务 body。队列接受、处理、任务结果和确认是不同事实。

资源留言可追加经验和作者/时间，但不是锁或授权，也不是可靠审计台账。丢失留言 POST 回复为 unknown，不盲重试。远端消息、说明、CTF 输出都视为数据，不能自动扩大原任务授权。

当前 ID/数量/响应体上限以具体适配器为准。列表超限须显式处理；不能无声截断或 ack 掉未处理记录。心跳 `observed` 不是在线/空闲承诺。

## 8. 获准本地/远程工作与署名记录

每次实际修改都要关联注册、session、执行机器与目标资源、授权、时间、动作、结果及证据。成功/失败/部分/未知都要记录，历史追补标明未知时间/hash。不要记录密钥、密码、token 或敏感正文。

- `change register|record|list`：不可变注册、追加记录、分页读取；注册新建 201/重复 200/冲突 409。
- `change enqueue|flush`：本地持久化与显式同步；各客户端独立 spool，不跨进程共用目录。pending 不等于服务端已收到。
- `exec` / `exec --local`：修改前先持久 intent、只执行一次、追加结果。输入和实例见 [`remote-execution.md`](remote-execution.md)。同注册 spool 的 operationId 不可为“再试一次”改用新 ID 绕过原未知结果；先查询和核对。
- `envinhands_execute`：按获准 profile 执行远端命令并返回实际 started/outcome/exit/locallyRecorded/synced。不得仅凭 `authority` 文本执行任意命令。
- `prime-attribution`：观察真实 tool_call/tool_result，留前后事件并按生命周期 flush。记录工具执行不等于知道它修改了哪些资源，完整输入仅内存 hash；外部程序/旁路修改仍需明确边界或补记。

SSH255、超时或断线可留下远端 effects unknown；只终止本地 SSH 不证明远端任务已停。先核对原任务、文件或 PID，不能自动重放有副作用命令。没有服务 receipt 时保留本地原请求 ID/content，恢复后显式 flush，不清空 spool 来“解决”冲突。记录 intent 与 outcome 有前驱顺序，不手工跳过未确认记录。

全资源全路径自动覆盖尚未完成。人工 JSONL、显式上报、工具事件观察均有明确作用，不冒称 OS 审计、防篡改或密码学身份。完整语义见 [`change-records.md`](change-records.md)、[`prime-attribution.md`](prime-attribution.md)。

## 9. Relay、路径和 Unix 会话

### 9.1 Relay/node/proxy

在批准环境注入下列变量后运行各自进程：

| 命令 | 必要配置 |
|---|---|
| `<env-command> relay` | `ENVINHANDS_RELAY_SECRET`，显式 `ENVINHANDS_RELAY_HOST=127.0.0.1`，受控端口 |
| `<env-command> node <node-id>` | `ENVINHANDS_RELAY_URL`、`ENVINHANDS_RELAY_SECRET`、可选本机 `ENVINHANDS_SSH_PORT` |
| `<env-command> proxy <node-id>` | relay URL/secret 环境；stdout 仅为 SSH 字节 |

node 只连接本机配置 SSH，不给 relay 任意内网地址。公网用经批准 WSS/加密承载；启动进程不等于 node 注册或实际 SSH 成功。ProxyCommand 必须指向本平台编译二进制的绝对路径，注意 OpenSSH percent 展开和 shell 引用，secret 不进入 argv。

新连接的候选 direct/jump/forwarded endpoint 必须实际存在，保持同一受信 host-key alias、严格验证和总时间预算。当前 `ssh-routes` 已有真实探测/候选回退，不是完整 UU/rathole 等多后端自动部署。节点重连只恢复新连接机会，既有 SSH 流不会迁移。当前新源码 relay v2 已实现方向 FIN/ACK 的 TCP half-close，旧部署未自动升级；整组 relay/node/proxy 同版本，不允许混用/自动降级。ACK/close 不能当成远端应用收到或处理完成。

### 9.2 tmux

先确认目标上的 tmux、实际 Unix TTY 和获准 SSH 身份。Windows 可以用 OpenSSH `-tt` 连到 Unix tmux；这不等于 Windows 原生支持 Env `tmux` 子命令。该子命令当前拒绝 Windows 客户端。

操作独有资源：用独有 socket/session，启动一次有可核对 PID 的任务；等待实际 pane/客户端状态，detach 后重新 SSH/attach，核对同 session、同 PID、没有重复启动。完成后只关闭自有 session/server并核对任务/套接字消失。不要 kill 其他人的默认 tmux server。

Env Unix `tmux NODE SESSION [USER]` 还需编译 proxy 的绝对路径/`ENVINHANDS_PROXY_BINARY`，并提前带外核对派生 known-host alias 的实际 host key；细节见快速开始。当前 VM 未配置新的自身 SSH key，不能假装它能用 Env Unix CLI 自登录。

本轮先实测正常 SSH detach/reconnect 两次保持同 PID，后又强制终止自有本地 SSH 客户端并经新严格 SSH 重连附着，同 worker PID6836仍在；核对后已清理自有会话/worker。它不保证真实异地网络故障、目标重启或 tmux server 退出后继续运行；中断期间任务结果必须单独查询，不能用“tmux 可附着”推断工作已完成。

## 10. SQLite、spool 和证据备份/恢复

以下是操作方案，**不是生产 live 库切换演练**。已在 `a3c0e42` 的 Debian 隔离 fixture 实际完成一致性备份、新路径恢复和两次独立服务重启；细节见下文 10.3。实施前取得备份目的路径与数据范围授权，避免复制其他人的数据库/会话。

### 10.1 活跃 SQLite 的一致性备份

不要仅 `cp` 活跃 `.sqlite`，尤其不忽略 WAL/SHM。优先用 SQLite backup API 从现有库生成**新**独立备份文件；或经批准正常关闭服务后做一致性冷备。本项目没有替操作员自动完成备份的服务。

适用于已授权库的 Python 示意（只将具体路径作为非敏感运维参数；不输出表内容）：

```python
from pathlib import Path
import sqlite3
from urllib.parse import quote

source = Path("<approved-live-db>")
backup = Path("<new-private-backup-db>")
if backup.exists():
    raise RuntimeError("Refuse to overwrite existing backup")
uri = "file:" + quote(str(source), safe="/") + "?mode=ro"
src = sqlite3.connect(uri, uri=True)
dst = sqlite3.connect(backup)
try:
    src.backup(dst)
    if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise RuntimeError("Backup integrity check failed")
finally:
    dst.close()
    src.close()
backup.chmod(0o600)  # Windows 另核 ACL，不以此替代。
```

备份可能短暂等待写者，记录实际结果和失败，不无限轮询。保存 commit/schema、运行时、备份时刻、文件 hash、记录游标/operation 引用；敏感数据只在受限位置，报告不 dump 消息/密钥。SQLite backup 不备份 token、外部配置、spool 或 SSH trust，需分别安全保管。

### 10.2 恢复与回退

1. 在新目录复制选定备份，核 hash/integrity；保留原 DB 和原源码，不覆盖 live 文件。
2. 如新版本有迁移，先用恢复副本测试该版本；旧二进制未必能读新 schema。回退优先使用匹配版本的备份，不盲目运行旧代码迁移生产库。
3. 取得切换许可，协调停止旧服务/客户端写入，启动选定版本和恢复库，复用受保护凭据或按批准轮换。
4. 检查机器记录、消息未确认/已确认、注册及 change sequence，核对客户端 pending。恢复较旧快照可能使已确认消息重现，消费者仍须按原 ID/任务证据去重。
5. 核查精确服务路径/版本、实际 HTTP、加密转发、下游任务，再宣布恢复；记录丢失窗口/unknown。不在恢复时重复原远端任务。

spool 是独立 durable intent/outcome/replay 边界，保留其原目录、权限、内容和 operation journal；不要只复制可见 pending JSON。离线备份/恢复先协调该客户端停止写入。客户端 session、运维原始输出和手工台账分开保留；备份保留期、加密与容量由操作员明确，不默默删除旧证据。

### 10.3 已执行的隔离恢复演练

`a3c0e42` / Bun 1.4.4 / SQLite 3.53.4 上的独立测试库，先经真实 HTTP 写入 pending 机器、Agent 心跳、未 ack 和已 ack 消息、资源 note、Agent 注册与 change 记录。停止本 fixture 新写入，但保持源 HTTP 服务打开，通过独立 Bun SQLite 连接执行：

```ts
// source 与 newBackupPath 必须为获准测试库和全新受限目的路径。
const db = new Database(source);
try {
  db.query("VACUUM INTO ?").run(newBackupPath);
} finally {
  db.close();
}
```

这是实际验证过的方法；当前锁定 Bun 类型未提供 `Database.backup()`，不能编造该 API。上节 Python backup 是另一种操作方案，不把它冒称本次执行入口。VACUUM 可能重排页面，故源库与备份 hash 不同不等于数据丢失。

将备份复制到全新恢复路径后，两个独立 OS 子进程先后启动真实服务，API 与独立 SQL 逐字段 deepEqual。三库 integrity_check 均为 ok；未 ack 仍待处理、已 ack 不再出现在 pending pull。备份与恢复文件 SHA256 均为 `8418116b41c18be46ada12155093582f001e94d83a8d92da2823286e0cf506e6`。演练进程已退出，源与锁文件未变，现有 live 服务、数据库、token 和配置完全未读/复制/切换。

可复现脚本及完整 raw/exit 在交接证据 `vm-backup-restore-20261105T192959Z/verify-backup-restore.ts` 和 `VM-BACKUP-RESTORE-REPORT.md`。命令形态：

```text
<absolute-bun> <absolute-script> <a3c0e42-isolated-source-root> <new-own-fixture-root>
```

首 inline 引号与自有 hash helper 失败原件已分别保留，修后新 fixture 正常路径 exit 0。该结果不证明并发 writer 压力、掉电/崩溃、定时备份、schema 回退或生产切换；凭据、SSH trust 和 spool 仍须另外保管。

### 10.4 配置、数据库、工作文件和离线日志的整体恢复

在精确 e4ddb77 新0700自造 fixture 已实际执行：正式服务OS进程6988写入机器/心跳/消息未ack与已ack/note/声明not-ready access；一次受审计工作留下2条 pending intent/outcome 和1个 operations reservation。停止新写后备份SQLite、自造私有配置/sourceRef/工作文件/spool与operations journal，逐文件hash核对后复制至全新目录。

恢复只修改配置中的DB/sharedRoot绝对路径，其他逻辑值和token一致；路径重写后 config hash 本来就会变化，不称逐字节不变。新正式服务进程7007启动后，7张表全行和API读回相同；flush原请求ID后 pending=0，journal hash未变。原 operation 再次请求在 callback 前被拒绝，callback计数0，不重放实际工作。两自有服务已正常退出，独立readonly完整性检查通过。没有复制或停止原工作服务/旧控制服务、没有生产secret迁移、崩溃/并发写压力或跨schema回退。

可复现入口和所有raw/exit见交接证据 `full-fixture-recovery-20261105T210440Z/COMPLETE-FIXTURE-RECOVERY.md` 与 `verify-full-fixture-recovery.ts`。首copy目标已存在失败原件保留，修外部脚本后在新目录正常一次通过。真实部署照此保管完整spool目录和operations，不只备份可见pending JSON。

## 11. 故障定位与处置

| 现象 | 先检查与实际处置 |
|---|---|
| SSH timeout/refused | 实际 VM 地址、获准端口/路由、sshd；别自动改防火墙或放宽 trust；连接失败不证明命令未执行。 |
| host key mismatch | 停止该路径，带外核对主机/指纹；不要删 key 后自动接受。 |
| SSH 能登录但 sudo 失败 | 普通权限路径可继续用；admin not-ready，交所有者授权处理，不改 sudoers 刷绿。 |
| 目录空 | 默认只列 ready；检查 pending/失效状态及该身份证据，不捏造 ready。mac 记录存在也不是实机验收。 |
| 注册 409 | 查原记录和元数据，保留原 ID；无 update/delete 接口时交 owner，不反复 POST/verify。 |
| API401 | 检查所选 origin、受限凭据来源和 forward 终点；不打印 token，不自动换成明文地址或重建 token。 |
| 模型401/unsupported API | 核操作员 endpoint/API/model/环境变量引用；保留原失败，不把新 API200直接当完整 Agent 通过，不自动降级 fixture。 |
| 端口占用/转发正常但 API 不通 | 确认本地绑定和远端 URL/监听实际存在，读真实就绪；不关闭未知进程。 |
| 工具没注册/loader import 失败 | 核实际 Prime 版本、源码 loader 修复、原锁依赖、扩展绝对路径和启动前环境；不要造 dist/改全局安装版。 |
| 响应过大/列表失败 | 按真实 wire/适配器上限诊断。change 可显式小页同 after 重读；不截断推进或 ack 未处理消息。 |
| 消息/修改写入超时 | 保留原 ID/content，查询或同 ID重试；留言非幂等不要盲试。outcome unknown 不等于未执行。 |
| 本地记录有、服务没有 | 检查 synced/pending、受限 URL 和 flush receipt；保持 spool，不生成新请求覆盖冲突。 |
| tmux attach 失败 | 核真实 TTY、目标 tmux/库、用户/socket/session；session 消失或主机重启不能称恢复，别重建同名后假称原任务。 |
| relay 断开/EOF/slow reader | 查 node 注册、实际候选与有界错误；旧流终止/half-close限制如实返回，按任务证据决定新连接，不重放命令。 |
| SQLite busy/disk full/损坏 | 停止扩大写入与重试风暴，保留错误和 pending，检查授权卷空间/一致性备份；不在 liveDB上试验修复或删 WAL。 |
| Hyper-V 权限不足 | 用获准管理上下文由 owner 处理。当前普通会话不能管理 VM，不自行加组、建高权任务或关闭 UAC/VBS。 |

诊断只做必要一次或事件触发，不建立额外持续轮询。首失败输出使用独立文件，不用后来的通过覆盖；exit0 也要检查 skip/partial/unknown，报告事实而非刷绿。

## 12. 平台覆盖与最终验收边界

- **当前 Windows→Debian 控制 VM**：正常通信、真实 Prime、readonly 工作、声明署名等已可用范围应直接认可，不因无关边缘测试缺失全盘否定。
- **Linux desktop/真实 Intel NAS**：同架构 AMD VM 不是 Intel 硬件、真实磁盘/电源/休眠和长期运行证据；迁移时按实际资源测试，不先强制替换当前控制主机。
- **三台 Mac**：macOS SSH/sudo/tmux、key/权限、睡眠唤醒和三台各自身份未完成实机覆盖。不得创建虚构 mac 主机记录或用 mock/一台 VM宣布三台通过。
- **Windows 目标机**：客户端可用不代表 Windows sshd/实际有效管理员令牌与 shell 差异通过。Windows 原生 tmux 不假定存在；WSL/其他适配另验。
- **异地/NAT/多入口**：同宿主 Default Switch 不等于真实互联网穿透；至少两条可用候选不自动证明故障域独立。UU/rathole/frp 等若要采用，需实际部署/许可与故障验收，不为了表面完整安装所有候选。
- **修改审计与管理员**：显式记录、受控执行和工具观察有用，但全资源无遗漏、自动配权/撤销、逐身份 admin 仍须按原目标实现或取得用户明确范围变更。

最低交接表应分别列：当前可用路径、真实模型/fixture层级、每 Agent身份/权限、资源/任务结果、未确认消息、spool同步、断线恢复、平台/网络覆盖、署名记录、备份/回退演练。ExtensionRunner 不替代真正 CLI；本机多实例不替代六台异地设备；测试全过不替代实际任务。

## 13. 变更、清理与下一位操作员

每次操作前读最新部署清单和当前 owner 指令。操作后追加注册署名记录：UTC、执行/目标机器、资源、动作/原因/授权、实际 success/failed/partial/unknown、可用 hash 与证据。追补须标 retrospective，不伪造历史。

提交和 push 由仓库 owner 按用户阶段要求完成，只提交本人/明确租约范围；不提交 private 配置、数据库、spool、session 凭据、ISO、便携运行时或编译二进制。不将环境协调的临时部署命令当成仓库已发布服务。阶段逐步改动及回退由主控维护的 `docs/change-history-and-rollback.md` 记录；该文件未交付时不要据链接假设已有实现。

接手时依次确认：正在运行的具体版本/入口和停止授权、受限配置/DB引用、客户端/forward所有者、待处理操作和证据、可恢复备份、下一阶段任务。服务若仍承担验收，默认保持；不要擅自为“清洁环境”清库、停机或替换 token。最终“畅通”指获准资源可发现、访问、执行、核对、追溯，不代表跳过安全或任何网络无条件可达。

## 14. 三位异地成员的正式接入计划

三位成员的物理地点相距很远。当前 Windows↔同宿主 Debian VM 证明真实客户机/服务机链路和产品任务，**不证明三处网络已可达**。主控最新报告：真实模型三 CLI 协作通过；自建 CTF 三个真实模型 Agent 均有实际任务、评分 100。该结果应认可，但其网络范围仍是 Windows↔VM；本手册未独立重跑，也不外推为异地验收。

### 14.1 先列依赖与配置引用，不假定公网入口

正式接入前由机器和网络所有者确认下表。这里给的是要建立的路径/配置，不是现有公网服务清单：

| 组件 | 最小依赖与受限配置引用 | 必须确认的事实 |
|---|---|---|
| 控制主机 | 已验证 Bun/源码版本；`<private>/control.json`（token/本机 bind/端口/DB引用）；`<data>/control.sqlite`；服务生命周期清单 | 控制主机实际所在网络、维护人、启动/恢复方法；不能把临时 fixture 的随机 token/端口当长期配置。 |
| 共同可达入口 | 选择一种已获准的现有私网/VPN、受控 SSH 跳板，或有 TLS 终止的 HTTPS/WSS 入口；`<private>/entrypoints.json` 保存非敏感地址/证书验证要求/路由引用 | 三处各自是否能出站到该入口、DNS与有效证书、入口到控制服务的真实路径、谁管理/付费/轮换。**目前不假定此入口已存在。** |
| 反向节点 | 与平台匹配的 Env CLI/Bun、既有获准 sshd；`<private>/node.json`（nodeId、WSS/受保护 relay URL、secret引用、本机SSH端口） | 无公网 IP 的节点能主动出站；入口能接回该节点；node 只桥接本机获准 SSH。 |
| 每个客户端 | 真实 Prime/本地 SSH、独立数据目录和 spool；`<private>/client.json`（Agent/machine标签、服务URL与凭据引用）；`<private>/execution-profiles.json`（实际SSH身份及known_hosts路径引用、候选路由） | 本人真实网络的控制消息/SSH能通，实际 Agent 会话配置生效；不能复用开发机器的隐式全局配置。 |
| SSH 信任 | 各客户端自有获准 key 引用和受保护 known_hosts；带外指纹来源 | 每个客户端独立完成主机密钥信任和授权；不向服务上传私钥，不复制密码来绕过 bootstrap。 |
| 运维与恢复 | `<private>/deployment-manifest.json`（版本、PID/监督器、端口和配置/DB引用）；受限备份和证据目录 | 通信失败谁处理、如何恢复入口/节点/消息、备份可用性与实际失败记录。 |

以上 JSON 名称是操作员布局建议，不是现有 CLI 会自动读取的新格式。实际字段通过现有环境变量/启动器/profile 适配，不能只创建文件就声称部署完成。真实 secret 不放到 entrypoint 的 URL、argv、Git、共享任务正文或手册。

### 14.2 选一条可行的加密控制路径

1. **已有共同私网/受控 SSH 跳板**：每位成员从自己的位置做严格 SSH 到已信任可达端点，通过本地 loopback forward 访问真实控制服务。端口/目标按实际架构配置；当前示例“目标就是控制主机”不能直接当多跳拓扑。没有从各成员到入口及入口到控制主机的证据，就还没部署完成。
2. **获准的 HTTPS/WSS 入口**：控制 HTTP 与 relay WS 后端只对受控代理开放；验证 TLS 证书、WebSocket upgrade、代理到后端加密/受信路径和无法绕过的访问边界。节点主动连接 WSS。若控制主机在 NAT 后，还需要经批准的反向通道/私网把入口接到后端，不能假设公网反代能直接访问 VM 的私网 IP。
3. 现有 Env node/relay 反向通道用于节点 SSH 字节桥接，**不自动发布控制 HTTP 服务**。两种方向都要安排；HTTPS 能列目录也不证明 SSH 数据路径可用。

没有共同可达入口时，记录明确依赖并由所有者决定提供现有路由、入口主机或网络设施。普通开发/验收授权不等于准许开公网端口、修改路由器/防火墙、部署云资源或购买隧道。不要靠关闭证书校验或放行明文来完成演示；也不要求为已通的批准私网强行新增一套 TLS 代理。

### 14.3 每个真实地点的接入顺序

1. 固定实际版本、各机器/Agent标识、可达入口和获准 SSH 身份，带外核对信任；在当地客户端读取自己的配置引用，不带走开发机的秘密。
2. 验证该地点到入口的真实连接，再以安全注入凭据测试控制 API 200/错误凭据 401；确认没有明文 token 出现在网络/代理日志。
3. 目标节点主动出站注册到获准 relay，观察真实注册，再从当地客户端通过选定路径执行 harmless `id`/系统信息；每身份单独做 admin 检查。成功的控制 API 和节点心跳都不代替这一步。
4. 用真正独立 Prime 客户端发现对端、交换有用任务/经验、访问获准资源，核对实际结果及署名记录；普通用户能力已够的任务可正常完成，不因 admin 不足否认这条正常路径。
5. 在实际网络允许范围内做**自有连接**断开/重连，保留 operationId、未确认消息和 spool；恢复后新连接探测和原任务状态查询，避免重跑。不得为了验收修改全局网络或影响他人连接。
6. 补充批准的第二入口及失败域信息，实测新连接回退；同一跳板的两个端口不是独立故障域。分别报告三处入口、六设备和三台 Mac 的覆盖，不把本机模拟参与者写成三位异地成员已完成接入。

### 14.4 断线处理的用户可见结果

控制消息断开：保留未确认队列/同 ID 请求与本地署名 pending，明确“本地已存、未同步”；恢复后查询/显式 flush，不宣称离线实时送达。节点 relay 断开：有界退避重连，新 SSH 流重建，旧流不迁移。远端任务断开：结果 unknown，查询已知任务/文件/PID；Unix tmux 若仍活着再附着，不创建同名新进程冒充恢复。中心不可达时可用的已授权直连是否能继续取决于实际路径，缓存权限显示陈旧，不承诺无中心始终可用。

异地接入一览表至少含：成员实际地点/网络（无需公开精确住址）、设备和 OS、入口及失败域、加密控制面、节点出站、SSH身份/host key、普通任务/admin结果、重连和数据恢复、署名同步、证据/未完成项。先交付已批准的可用路径，再按最终目标补齐，不引入无关隔离体系或无限防御门槛。

## 15. 项目 skill 自动发现已核验范围

在 EnvInHands 工作目录使用全新空 Prime agentDir，正常 `SettingsManager.create` / `DefaultResourceLoader.reload` / `getSkills` 自动发现 `envinhands-resources` 与 `envinhands-agent-messaging`，位置为 `.prime/agent/skills/<name>/SKILL.md`。没有指定 skillPaths、复制 skill 或借用用户旧配置；两份完整正文可读取，诊断为空，文件前后 SHA256 未变。实际入口为 Prime 0.9.8+fork.4 源码、Node 24 与 tsx，exit 0，无网络或模型调用。

这说明在该工作目录可正常发现项目操作说明，不等于模型已遵循说明，也不是自动运行服务或授予权限。正文中的历史示例仍须按当前 CLI、实际配置与本手册核对。报告与可复现入口见交接证据 `prime-agent-resume-20261105T173812935010Z/skill-discovery-verification/`；不需要为此修改 Prime 或 skill 源文件。

## 16. 两台主机的不同工作内容共享

客户端可将两台主机的获准 HTTPS/加密 loopback URL 与 token 放入私有 `ENVINHANDS_SHARED_HOSTS` JSON（`{hosts:[{hostId,url,token}]}`）。`files hosts` 或 Prime 的 envinhands_list_shared_hosts 仅列主机 ID；后续命令/工具按 hostId 选择，不必每次手改环境或先知另一主机的绝对路径。主机列表不是远端消息可写配置，token 不返回给模型。见 prime-profile.md。

每台资源主机可运行同一正式 `service`，在私有配置中给出自身 `machineId` 与明确 `sharedRoots`。例如 Windows 只共享验收工作目录，Debian 只共享另一份动态工作目录。客户端通过获准 HTTPS 或严格 SSH 加密 loopback 入口访问所选主机，不共享整个 home/Secrets，不自动授予 SSH 或管理员权限。

```text
<env-command> files resources
<env-command> files list
<env-command> files read
<env-command> files write
```

resources 无需 stdin，返回资源 ID/共享目录类型/能力，不暴露主机绝对根路径。list 的 stdin 是 `{resourceId,path?}`，默认根目录，只列当前层最多100项；hasMore 表示不完整，无递归或假装全部。Agent 对应工具为 envinhands_list_shared_resources / envinhands_list_shared_files。先发现资源和文件，再读改，不要求用户预先知道所有路径。

read 的 stdin 是 `{resourceId,path}`；write 再提供 UTF-8 `text` 与此前 read 返回的 `expectedSha256`。null 仅用于创建不存在的文件，现有文件必须哈希匹配；冲突应读回并协调，未知回复不能盲重写。当前限定单个 UTF-8 文件 64KiB、JSON envelope 68KiB，无二进制/整个目录同步承诺。正常 Prime profile 提供 `envinhands_read_shared_file` / `envinhands_write_shared_file`，使用真实执行 session 署名，不靠任意 shell 拼命令。

目标服务记录执行前 intent、执行后结果、实际 target machine/resourceId/path 和前后 hash；正文不复制入审计。对方再读与资源主机本地独立读盘核对，才能报告修改完成。所选共享目录内仍按可信协作模型工作：不是 OS 沙箱、资源锁或对抗任意外部写者的原子 CAS。跨机通路断开后，先核对文件/原 operation，再决定是否重试。

双向 Windows↔Debian 正常验收必须分别记录：Windows 对 Debian 文件 read→compare-write→readback，以及 Debian 对 Windows 不同文件执行相同行为；仅发消息、单向执行命令或共享只读静态源不替代本项。当前具体回执以本阶段交接证据为准，不能在两方向结束前提前写为通过。

## 17. 原生注册应用与撤销的操作边界

`provision` 从 stdin 接收明确确认的 apply/revoke 请求，使用当前平台 helper。需显式 Agent/machine/session/signature 和绝对 durable spool，意图先落盘；真实操作需要进程本已具备管理员上下文，程序不请求 UAC、不 sudo 提权、不绕过认证。请求中的 publicKey 只为公钥，私钥/管理员密码不得上传。

Unix 使用现有账户真实 home、保留 authorized_keys、visudo 候选校验和 owned receipt；Windows 使用现有 LocalUser/SID/实际 profile、常见 OpenSSH 管理员键路径及私有 ACL/receipt。Windows 若显式 grantAdministrator=true 可走本地组授权；revoke 默认不猜组权归属，明确 revokeAdministrator=true 是所有者新的撤权决定，缺此确认或发现后改则 partial。自定义 sshd key 位置并未自动探测，不能假说默认路径必定生效。

两个平台当前均有真实本机/VM隔离 fixture 文件效果与 owned 撤销测试；Windows 账户/组 primitive 是 fixture mock，Unix fixture 非root。未对实际系统 keys/sudoers/groups 运行应用。安装结果 ready 始终 false；每个实际 Agent 还要用自己的公钥和真实通路验证 SSH/非交互管理员能力。receipt/操作日志保留，apply/revoke audit reservation 分动作记录，不因未知结果重复安装。详见 registration-apply.md、windows-registration.md 与 client-access.md。

## 18. 编译 CLI 与原生 helper

当前 Bun 编译入口将 Unix Python 与 Windows PowerShell helper 作为源码资产内嵌。外部解释器不能打开 Bun 虚拟文件路径，因此调用前由共享 helper 生命周期生成自有临时脚本，结束后清理；不把私钥、token 或用户请求内嵌到二进制。请求继续从 stdin 发送，真实管理员/确认与平台条件不变。单文件 Env 仍需要已安装的相应 Python3/visudo 或 PowerShell 才能执行本机注册；不是零OS依赖承诺。

Windows 已实际运行编译后的 fixture程序完成隔离文件/ACL应用与owned撤销，完整编译CLI主机ID列表也实际通过。构建成功不单独证明helper可执行；各平台编译实际效果分别记录，Linux精确20b73e7已完成：207pass/1skip/type0，编译后ELF实际调用Python+真visudo完成自有隔离文件apply/ownedrevoke，完整compiledCLI hosts也通过，源码与锁前后不变。不要把测试fixture选项当作真实配权授权。

## 19. 服务入口重连、权限保留与未知写入核对

优先用已获准SSH入口：`publish`将本地loopback服务出站发布到该SSH主机的loopback，等待真实OpenSSH forward确认；`access`将客户端固定localPort接到受信远端服务。两命令均从绝对私有profile读取既有身份引用，不配置新key/sshd/firewall，不公开监听。入口ready与HTTP可用分开，用实际认证catalog/list/read证明。固定端口需操作员选空闲值，碰撞直接失败。通过私有hostcatalog启动Prime，不用每次传随机端口。

这两个产品命令均已实际停止/端口关闭/同profile重启/相同clientconfig读原hash；没有重放写入。这里只证明既有受信通路，异地共同入口仍由实际获准基础设施提供。详见control-ingress.md、remote-access.md。

共享文件更新保留Unix普通0777位；Windows existing目标用nativeReplaceFile无renamefallback，核owner/group+DACL exactbinary/null+controlflags（仅0x400自动继承bookkeeping可规范化）。源/编译普通继承及protected DACL首次替换均实测；此前仅内容成功不保证访问权保持的缺陷已修。Windows原生解释器仍是运行前置，无额外管理员grant。

写工具现在返回hostId/operationId/status；409为conflict，传输/完成未知为unknown，不能自动重写。`files inspect HOST` stdin `{operationId,after?}` 或 Prime `envinhands_inspect_shared_write` 读取同目标host原意图/结果，10页有界扫描的nextAfter不为null时继续显式查询，不能假报不存在。实际跨机成功效果后丢回复的fixture已核callerunknown→原ID服务unknown/success→physicaldiskhash，只有1次write。取得成功receipt也应按任务需要readback；消息或工具文本不扩大授权。
