# 开发交接

> 当前为实验原型，不能直接用于生产或公开暴露公网。

## 2026-11-06 NAS pilot：实际状态与恢复

- NAS 为 Debian 12 x86_64，现有 FRP 只暴露其 SSH 入口；Env 控制与 relay 均监听 NAS loopback，客户端通过 SSH 加密转发访问。NAS 用户级服务 `envinhands-team-control`、`envinhands-team-relay` 和 `envinhands-team-readiness` 在运行；服务/relay 版本基于 `654b36a`，control 使用修复重复 exec 的实验二进制，readiness 为独立构建。后续代码尚未全部部署，不能仅以 Git HEAD 断言服务版本。
- 为 NAS 账户添加了仅该用户的 `AllowTcpForwarding local` SSH 配置（`/etc/ssh/sshd_config.d/00-envinhands-team-forwarding.conf`），变更前后 `sshd -t`、匹配用户及 root 策略检查通过并 reload；没有新增公网端口。回退先停用使用该转发的 Env 进程，再删除此 owned 配置并 `sshd -t` 后 reload；不要改其他 SSH 配置。
- NAS 账密与本次传输配置不在仓库。NAS 控制配置在 `~/.local/share/envinhands/` 的 team pilot 目录，以 owner-only 权限保存；本机客户端入口在 `~/.config/envinhands/` 的对应 team 私有目录。NAS 专用 SSH key 不应转发或提交。
- `local-desktop`、`mac-laptop` 和 `rtx-home` 已通过 NAS relay 的真实 SSH + 管理员能力检查；本机与 Mac 的各自客户端密钥还分别做过双向 SSH + sudo。服务端 ready 是该身份检查时点结果。RTX 有效 Windows 管理员 token 经过真实 SSH 测试。
- 本机用户 systemd units `envinhands-nas-tunnel` 和 `envinhands-local-node`；Mac 用户 LaunchAgents `io.envinhands.pilot.tunnel/node`。它们使用私有配置、只处理当前用户会话；Linux linger 未启用。RTX `\EnvInHands-RTX-NAS-04bfb228b4d7` 是该用户登录触发的 Limited 任务，断 tunnel 后自动恢复已实测，未实测注销/登录。节点不保证机器休眠/断电持续在线。
- 本机及 Mac 的两个真实 Prime 0.9.8 会话经 NAS 用**现有协作工具扩展**双向 send/pull/ack 并共同读写 notes，非原生 agent_message。独立的两个真实 Prime daemon + 临时服务已验证 native mesh roster/stored/接收记录/ACK，尚未在真实 NAS/三机加载验证、未证明断电恢复。
- 用户要求 team/prime 与主线共存、自动复用现有 0.9.8 配置、自动加载 skills、Agent 名以前缀标示节点。Prime 原生跨机代码在开发并已通过隔离双 daemon 的 stored、持久、ACK、同 operation ID 重试及故障边界测试；尚未在真实 NAS/三台设备实测或发布。新服务端必须先升级，随后升级客户端，不能将本地代码等同于已部署服务。
- EasyTier v2.6.4 在本机与 Mac 的临时独立网络实测双向 SSH、P2P/TCP 及断链重连，默认路由不变；本次是同 LAN，不等于跨 NAT/公网。运行进程及临时配置按用户 pilot 管理，停止前须核对所属；Cloudflare Quick Tunnel 实验返回 530，FRP 官方本地数据平面可测，UU 不应误称跨机接通。
- 账号密码曾出现在对话中，建议用户自行轮换；切勿将密码、token、私钥或团队私有服务配置提交至 Git 或日志。共享 token 在团队信任域内有效，不提供个体强身份。

## 2026-11-06 整合开发说明

本轮本地整合验证：Bun 1.4.4，启用官方本地 FRP 测试和用户 FRP 配置离线解析时 **333 通过、1 跳过（真实 Cloudflare Quick Tunnel；本次独立 live 测试失败）**，类型检查通过。FRP 测试没有启动或覆盖用户已有 proxy。这里记录本地代码测试，不等于 NAS 运行版本已经升级。

Prime fork `npm run check` 通过；对变更测试使用三个乱序种子检查均通过，每轮 296 通过、2 跳过。native mesh 已通过临时服务双 daemon 的注册、发现、持久投递、ACK 和同 operation ID 重试，**尚未在真实 NAS/三台设备运行该新版本**。

新增 Agent 画像 notes、native mesh 目录分页、服务器/节点 debug 事件日志、断线检测、自动复核与传输 sidecar；多个后端仍需真正接线和跨网络验证。日志只含事件元数据，不含 SSH 终端正文；共享 token 是团队信任，不构成个体强身份。原访问证据旧 API 的失败重验与并发 stale-ready 问题仍在，新增 generation API 尚未被现有消费者完整使用，不可把旧 evidence 当成当前 Agent 的保证。

## 最新可接手版本

- Env功能源码 `ba9a9d289eb1adb18799e18b2d597c7c1aa0d6c9` 已push并独立核远端SHA：Windows221pass/type0，精确186文件Linux220pass/1skip/0fail/type0。唯一skip为可选外部Prime直接导入；单独真实Prime证据见下。
- Prime fork `88b7d8cbc137fd307f29aa51edac3e472ea174ff` 已正常hooks提交push、root独立核SHA；必要source-loader修复和最小安全依赖/ZIP修复分提交保留。剩余依赖告警明确，不称全安全。
- 真实模型三独立Windows CLI消息环与全员自主CTF100成立；后续Windows↔Debian不同工作内容互读/改/读回/双方独立盘hash+署名成立。Debian真正完整Prime CLI工具循环也改过Windows工作文件，不只SDK。
- 最终正常冷启动：原Node controller→真实Prime CLI PID8332/session01a1adbf-9e54-7198-95a3-b51ab7b8e7ec，新配置7Env扩展/2skills且未禁用skills/builtin，8实际Agent工具turn读取两host与inspect原operation，0workwrite/0paid。首Node客户端误加载.ps1由纯model/server边界修复，未用Bun控制器绕过。
- 正式资源服务运行源码2801896（Windows/VM），ba9是兼容纯客户端模型/文档提取，**不声称已热升级服务**。旧5b8deaf控制bus保持独立。实际PID/入口/私有配置引用和owned清理边界见工作区 handoffs/12-current-runtime-manifest.json，凭据值不进Git。

先读 [当前验收](docs/acceptance-report.md)、[正常流程](docs/normal-workflow.md)、[运维手册](docs/operations-manual.md)、[目标对照](docs/goal-conformance.md) 和 [演进回退](docs/change-history-and-rollback.md)。下面保留接手与中间阶段历史路径/统计，不能覆盖本节当前事实。

原始目标未全部完成：真实六设备/Mac/异地、每个指定Agent管理员正向与真实配权/撤销、工具外所有修改路径、长期生产安全仍需继续。Unix/Windows owner-confirmed helper已实现并隔离效果测试，不是实际系统已授admin；当前真实sudo-n仍失败。不要用更多无关矩阵或重复付费CTF替代所需外部条件，也不得未经授权改key/sudoers/groups/firewall/public监听。

## 仓库与基线

- EnvInHands：<https://github.com/nkanf-dev/envinhands>，本地 `~/projs/envinhands`。
- Prime Agent fork：<https://github.com/nkanf-dev/prime-agent>，从 `peterkc/prime-agent` fork。目标保持 TypeScript 0.9.8 系列。
- Prime Agent fork 已浅克隆至 `~/projs/prime-agent`；所有我方改动已直接推送 [`main`](https://github.com/nkanf-dev/prime-agent)（`e398494`）：opt-in 生命周期 heartbeat、消息收发与资源工具。真实 0.9.8 loader 已在隔离环境加载心跳和四个消息工具；资源扩展有本地测试，尚未验证跨机或自动注入。

## 当前控制主机与最终测试环境（用户已明确）

Hyper-V VM `EnvInHands-Debian12` 是本项目**当前控制主机**，不仅是外围模拟环境；用户已明确最终集成测试可以使用它。后续控制面、持久消息服务、relay 和多个 Prime 客户端协作验收以此 VM 为控制主机组织。未来真实 Debian NAS 的平台迁移与六设备/跨互联网覆盖另列验收，不以尚未覆盖真实 NAS 为由否定这台控制主机上的有效集成证据。

环境基线：Debian 12.15 amd64、4 vCPU、4 GiB、64 GiB 动态盘、Hyper-V Default Switch NAT。网络地址可能变化，连接前复核；SSH 必须继续使用既有受信 host key 和获准身份。当前 `sudo -n` 失败，不能宣称管理员 ready；控制主机角色与最终测试使用许可不等于项目已部署或权限已满足。运行时/依赖安装由环境协调统一准备，具体安装仍按获准范围执行；不隐含公钥/sudoers 修改或公网开放许可。不得把私钥、密码和 token 写进仓库或交接。

## 历史阶段：署名记录与可移植执行

本阶段主要能力在 EnvInHands 仓库，不依赖继续增加 Prime 业务分支：

- `src/change-{model,store,api,client,spool,cli}.ts`：不可变 Agent 注册、共享 bearer 下声明署名的追加记录、幂等请求、分页、离线持久队列和显式 flush。所有实际修改须留记录；这些原语与显式工具尚不自动捕获任意外部程序的全部写入。
- `src/integrations/prime.ts`：外部可加载的三个审计工具，绑定实际 Prime session。`scripts/prime-client.mts` 和 `verify-prime-clients.mts` 使用真实 loader/schema/tool wrapper，分别验证真实独立进程，不调用模型。它们是验证入口，不是完整 daemon/TUI Agent。
- `src/transports/ssh-routes.ts`：真实严格 SSH 探测，统一 host-key alias，有限总预算和候选回退；没有自动安装 UU/rathole 或承诺公网穿透。
- `src/audited-operation.ts`、`local-execution.ts`、`remote-execution.ts`：修改前持久 intent，执行一次，修改后追加结果；本地 argv 与远程命令共享进程生命周期。超时/SSH255不盲目重跑；本地记录不等于服务端已同步。
- `src/client-access.ts` / `verify-access` CLI：实际客户端身份、注册/session、路径、管理员结果与TTL的本地证据，不再以服务端成功替代其他 Agent；不是可防伪的服务端委托证明。
- 使用说明见 `docs/change-records.md`、`docs/remote-execution.md`、`docs/prime-adapter.md` 和 `docs/prime-clients.md`。

Windows Bun1.4.4 native stage run：169 项通过、0失败、0跳过，typecheck通过。该运行显式使用 sibling Prime checkout，旧可选 heartbeat direct-import 用例也运行；它仍不是 loader 证明。真实 loader/独立进程以单独脚本报告为准。更早的 Windows 首typecheck及POSIX tmux测试预期失败日志保留，未被后来通过覆盖。脚本 `.mts` 已纳入正常 tsconfig 类型检查，提交前必须与源码一并通过。

控制VM已分别验收不可变74文件审计快照（157pass/1skip）和82文件执行快照（164pass/1skip）、各自typecheck0/hash前后不变；不能以早快照证明后加功能。真实 Windows compiledCLI -> encrypted SSH forward -> VM relay/node -> sshd 成功，错误secret/host key拒绝，sudo-n失败仍not-ready。真实Unix tmux经严格SSH PTY两次附着/分离/重连保持相同worker PID，未证明突发断网/重启、Env Unix tmux CLI自身身份登录或全部设备。

最终目标与开发原则、全Agent本地远程修改署名记录必须在压缩交接中保留，见工作区 handoffs/06、07、08。阶段commit/push已由用户明确要求；只提交已验证自有范围，不提交凭据、测试DB、便携运行时、编译二进制或临时报告。

## 接手/中间阶段代码快照（历史）

- `src/control.ts`：内存机器、心跳、资源留言控制面。无认证、TLS 或持久化；不得公网暴露。
- `src/relay.ts`：WebSocket 反向 TCP 中继实验原型。仅共享 bearer 密钥；任何持钥者能冒充节点或连接节点；有基础应用层限额但无完整公网防护；不支持透明 TCP 半关闭，也不能保证 WebSocket 关闭后的远端排空错误会传回。不要生产使用。
- `src/transports/policy.ts`：根据传入的探测结果选择并回退；不执行探测或连接。`src/cli.ts` 现包含 server/relay/node/proxy/register/tmux 子命令；tmux 需要交互 TTY。
- `src/transports/uu.ts`：调用外部 `uuremote-viewer portmap` 的进程封装。启动不代表连接成功，未实测 UU。
- `src/transports/rathole.ts`：启动预装 rathole 的进程封装。启动不代表连接成功，不负责生成配置、密钥或校验 TLS。
- `src/readiness.ts` / `src/windows-readiness.ts`：检查服务端 SSH 身份在 Linux/macOS 是否能无交互 `sudo`，或 Windows 会话实际管理员令牌（仅 mock，未在真实 Windows 实测）；支持可配置 relay 代理。并不注册账号或安装公钥。`src/registration/linux.ts` 与 `native/linux-register` 只生成计划，apply 始终阻止执行；Rust 实验依赖系统 libsodium。
- `src/session/tmux.ts` / `tmux-relay.ts`：构造 tmux SSH 参数及经 relay 的 ProxyCommand；CLI `tmux NODE_ID SESSION_KEY [USER]` 已接入，需交互 TTY 并提前信任派生 host key，尚未实机验证持久会话；不保证机器重启后会话存续。
- `src/agent-bus.ts` 和 `src/server.ts`：实验性 SQLite Agent 心跳与消息持久队列，内置 Bun HTTP 监听，默认 `0.0.0.0:8787`、共享 bearer，无 TLS。部署显式使用 loopback 或获准加密入口。接受仅表示存储，消费可能重复；同一 token 可冒充任意 Agent。只能在可信网络或正确配置的 HTTPS 反向代理后面使用。
- `src/prime-bridge.ts`：Agent bus 的 TS 客户端，提供显式 heartbeat/send/pull/ack；Prime fork 通过独立的 opt-in 工具调用同一总线，但不会自动把远端消息注入本地 session。
- `src/storage.ts` 和 `src/machine-api.ts`：机器元数据与留言 SQLite 存储和 bearer API；已接入 `src/server.ts`，但仅登记数据，不安装 SSH 或设置管理员权限。
- `docs/design.md`、`docs/protocol.md`：以长期目标为准的详细设计和待开发契约；`docs/architecture.md`、`docs/transports.md` 与 `docs/quickstart.md` 记录架构草案、连接候选及原型用法。
- `.prime/agent/skills/envinhands-resources`、`envinhands-agent-messaging`：Agent 操作 skills；新空 Prime agentDir/Env cwd 自动发现与正文读取已验证；正常 profile 又在无关工作目录验证显式 skill 加载。与历史关闭 skills 的模型验收分别报告。

## 历史验证（旧 Linux 开发环境）

以下记录来自旧 Linux 开发环境，不是当前 Windows 工作站的测试结果。Bun 1.4.4；当时 `bun test`：137 项通过；`bun run typecheck`：通过。后续改动的实际测试结果以最新提交为准。测试包括本地 socket 和 mock；另已用单文件 CLI、临时 sshd 和密钥完成一次真实本机 OpenSSH 测试，正确主机密钥成功、错误密钥被拒绝。不证明真实 UU、rathole、Windows/macOS 或互联网可用。实验中曾复现反向中继背压和关闭丢数据；当前测试已覆盖部分回归，但实际网络背压和异常语义仍需审查。Prime Agent 的三个扩展使用真实 TypeBox 跑过 26 项本地测试；真实 0.9.8 扩展加载器隔离加载了心跳与消息工具，但资源工具尚未作真实加载器测试。用户明确不需要 CI；原 GitHub Actions 工作流已移除。以本地测试为准。

```bash
cd ~/projs/envinhands
export PATH="$HOME/.local/share/envinhands/bin:$PATH" # 当前机器上的 Bun
bun install --frozen-lockfile
bun run typecheck
bun test
git status --short --branch
```

## 当前 Windows 复验（2026-11-05 UTC）

- 基线：`main` / `3d733935c5f2aa8106504c23cafc13404211171a`；开始时工作区干净。Node `v24.14.1`；Bun、cargo、rustc、tsc 不在 PATH，仓库无 `node_modules`；未安装依赖或改动锁文件。
- 现有 Node 聚焦测试 21 项通过（exit 0）：

```text
node --experimental-transform-types --test test/policy.test.ts test/linux-registration.test.ts test/prime-bridge.test.ts test/control.test.ts
```

- readiness 首次尝试负向名称筛选未达到预期，实际执行 13 项，11 通过、2 失败（exit 1）。失败为 `relay ProxyCommand quotes its absolute binary path and never contains credentials` 和 `Windows relay uses the shared POSIX proxy and the same fixed token check`；两者要求 POSIX relay 成功，但源码明确拒绝 Windows 客户端 relay，不能把这次运行报为通过。测试使用 mock runner，不是真实 SSH。
- 改用显式名称筛选的跨平台 readiness/mock 测试 9 项通过（exit 0）：

```text
node --experimental-transform-types --test --test-name-pattern="Linux and macOS|unknown platforms|untrusted target values|nonzero, signal|success checks|non-admin, timeout|rejects untrusted SSH|unsupported OS|the main readiness gate" test/readiness.test.ts test/windows-readiness.test.ts
```

- 21 + 9 为所选测试，不是全套通过；首次失败日志与后续结果分开保存在工作区 `handoffs/evidence/envinhands-20261105T174016575538Z/`，各有原始输出和退出码记录。
- 本次仅修正文档现状漂移，不改线协议或产品行为。尚未完成本机 Bun/SQLite/relay/CLI 全套、typecheck、Rust、真实 Prime loader、VM/多机/公网/tmux 验证。联网安装运行时和依赖须先获用户确认。

### 本轮继续开发：平台预期与 HTTP 契约用例

- 读取用户提供的 `Desktop/1.txt`，确认两个仓库地址为 <https://github.com/nkanf-dev/envinhands> 和 <https://github.com/nkanf-dev/prime-agent>，历史提交与本地基线一致。`git ls-remote origin refs/heads/main` 本次因连接重置退出 128，不能声称当前 GitHub 远端仍与本地同步；未 fetch/push。
- 修复 `test/readiness.test.ts`、`test/windows-readiness.test.ts` 中两项测试的平台预期：POSIX 保留原成功路径和参数断言；Windows 断言 relay 返回 `not-ready`、`ready: false`，且不调用额外 SSH runner。无 skip，不改变生产代码或放宽 host-key/管理员检查。
- 修复后两份 readiness 测试完整执行 13/0；随后以下六文件联合运行 **34 通过、0 失败、0 跳过，exit 0**：

```text
node --experimental-transform-types --test test/policy.test.ts test/linux-registration.test.ts test/prime-bridge.test.ts test/control.test.ts test/readiness.test.ts test/windows-readiness.test.ts
```

- `test/server.test.ts` 已补真实 HTTP 消息 `201/200/409`、heartbeat 省略 task 清空、重复 ack、缺 token 的 bus 拒绝、无/错误 token 的目录与资源拒绝、同内容留言产生不同 ID 并在重启后保留的用例。该文件测试通用 PrimeBridge 与服务，不证明真实 Prime 扩展兼容：斜杠 requestId 是服务允许而当前 Prime 消息扩展拒绝的边界，真实扩展联调须另用双方兼容的 ID；ready TTL 另有存储/API 测试，不由此文件证明。该文件监听均显式设为 `127.0.0.1`，端口由系统分配，token 随机生成且不输出。**新增 Bun/SQLite 用例尚未运行，typecheck 也未运行**，不以 Node 34 项代替。
- 证据在工作区 `handoffs/evidence/envinhands-20261105T174545791443Z/`，各次 raw 与 exit 独立保存。前一轮首失败记录不覆盖。`git diff --check` 通过；未安装依赖、改 lock、配权、部署 VM、改 CI 或 commit/push。
- 后续：由环境协调唯一准备获批的便携 Bun；本仓库负责人在明确授权后按现有锁文件安装依赖并禁生命周期脚本，执行 typecheck/Bun 全套与免模型 loopback。六设备/公网、逐 Agent 真身份 SSH 与无交互管理员能力、自动配权、多后端回退和真实 tmux 恢复仍待开发或验收，最终目标不缩减为本机消息测试。

## 用户目标和未完成的高优先事项

1. Prime Agent TS 0.9.8 与本项目实际接线；验证 Agent 跨机器发现和收发，不能把本机跨 daemon 能力当成跨机。
2. 节点安装注册：本机确认配置 SSH 公钥和团队管理员访问。Linux/macOS 必须验证 `sudo -n true`；Windows 必须验证实际管理员令牌。私钥和管理员密码不上传。当前只有检查组件，没有配置流程。
3. 集成真实 rathole/wstunnel/frp、UU 等后端，探测实际状态并尝试回退；分别检查许可证和服务条款，绝不默认其已可用。
4. SSH 本地代理/CLI、WSS/TLS、身份与主机密钥、持久化、自动重连、闲置超时、限流和清理。tmux 只提供远端会话保留，断线期间命令是否执行仍需应用确认。
5. 覆盖真实 TCP 背压、半关闭、中继重启、断网、休眠、长时间 SSH 及三平台的端到端测试，记录不可恢复的失败。
6. 增加 Agent 活动、机器留言持久化及运行态观察，区分状态过期与不可见的 Agent。

## 恢复工作

先检查两仓库最新远端分支和工作区，不要覆盖已有修改。`envinhands` 的 server、relay、node、proxy 已通过 CLI 接线，但后端自动选择、自动配权和 UI 未完成；文档中的所有候选均不是可部署承诺。网络差时优先保存源码与本文件，再重新尝试获取 Prime Agent fork。
