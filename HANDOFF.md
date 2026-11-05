# 开发交接

> 当前为实验原型，不能直接用于生产或公开暴露公网。

## 最新可接手版本

功能提交 `a3c0e426f82dca07498975811921ce1e2dca23ce` 已完成独立 Windows/VM 验证：Windows 181 pass；Debian 隔离副本 180 pass、1 skip、0 fail，两端 typecheck 均为 0。VM 的唯一 skip 是无外部 Prime checkout 的可选直接导入，不是 181 全通过。123 文件源码包及锁文件前后 hash 一致。

三个真正独立 Prime CLI/daemon/session 使用 gpt-6.1-terra 完成 Windows→VM 协作和自然分工的自建 CTF，全员参与，评分 100。`device register` / `device inventory`、`access` 正式 API/CLI、工具事件署名观察和只读文件适配已接线；真实普通用户 SSH 不代表管理员 ready，当前 sudo -n 仍失败。运行中旧 bus 未随隔离测试升级。

原始目标与每项证据见 [目标对照](docs/goal-conformance.md)，部署/使用/备份见 [运维手册](docs/operations-manual.md)，阶段顺序与撤回见 [演进与回退](docs/change-history-and-rollback.md)。下面旧路径和统计是历史基线，不替代本节。当前功能提交在保留首失败后已正常 push，并由 git ls-remote 完整 SHA 核对。三台 Mac、完整六设备、真实异地网络、逐 Agent 管理员正向授权与自动配权/撤销仍未闭合。

## 仓库与基线

- EnvInHands：<https://github.com/nkanf-dev/envinhands>，本地 `~/projs/envinhands`。
- Prime Agent fork：<https://github.com/nkanf-dev/prime-agent>，从 `peterkc/prime-agent` fork。目标保持 TypeScript 0.9.8 系列。
- Prime Agent fork 已浅克隆至 `~/projs/prime-agent`；所有我方改动已直接推送 [`main`](https://github.com/nkanf-dev/prime-agent)（`e398494`）：opt-in 生命周期 heartbeat、消息收发与资源工具。真实 0.9.8 loader 已在隔离环境加载心跳和四个消息工具；资源扩展有本地测试，尚未验证跨机或自动注入。

## 当前控制主机与最终测试环境（用户已明确）

Hyper-V VM `EnvInHands-Debian12` 是本项目**当前控制主机**，不仅是外围模拟环境；用户已明确最终集成测试可以使用它。后续控制面、持久消息服务、relay 和多个 Prime 客户端协作验收以此 VM 为控制主机组织。未来真实 Debian NAS 的平台迁移与六设备/跨互联网覆盖另列验收，不以尚未覆盖真实 NAS 为由否定这台控制主机上的有效集成证据。

环境基线：Debian 12.15 amd64、4 vCPU、4 GiB、64 GiB 动态盘、Hyper-V Default Switch NAT。网络地址可能变化，连接前复核；SSH 必须继续使用既有受信 host key 和获准身份。当前 `sudo -n` 失败，不能宣称管理员 ready；控制主机角色与最终测试使用许可不等于项目已部署或权限已满足。运行时/依赖安装由环境协调统一准备，具体安装仍按获准范围执行；不隐含公钥/sudoers 修改或公网开放许可。不得把私钥、密码和 token 写进仓库或交接。

## 当前开发阶段：署名记录与可移植执行

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

## 已有代码

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
