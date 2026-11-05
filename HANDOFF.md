# 开发交接

> 当前为实验原型，不能直接用于生产或公开暴露公网。

## 仓库与基线

- EnvInHands：<https://github.com/nkanf-dev/envinhands>，本地 `~/projs/envinhands`。
- Prime Agent fork：<https://github.com/nkanf-dev/prime-agent>，从 `peterkc/prime-agent` fork。目标保持 TypeScript 0.9.8 系列。
- Prime Agent fork 已浅克隆至 `~/projs/prime-agent`；实验分支 [`envinhands-integration`](https://github.com/nkanf-dev/prime-agent/tree/envinhands-integration) 已推送 `325c184`：opt-in 生命周期 heartbeat 扩展及本地测试。尚无 Prime 消息收发/ACK 接线或跨机实测。

## 已有代码

- `src/control.ts`：内存机器、心跳、资源留言控制面。无认证、TLS 或持久化；不得公网暴露。
- `src/relay.ts`：WebSocket 反向 TCP 中继实验原型。仅共享 bearer 密钥；任何持钥者能冒充节点或连接节点；有基础应用层限额但无完整公网防护；不支持透明 TCP 半关闭，也不能保证 WebSocket 关闭后的远端排空错误会传回。不要生产使用。
- `src/transports/policy.ts`：根据传入的探测结果选择并回退；不执行探测或连接。
- `src/transports/uu.ts`：调用外部 `uuremote-viewer portmap` 的进程封装。启动不代表连接成功，未实测 UU。
- `src/transports/rathole.ts`：启动预装 rathole 的进程封装。启动不代表连接成功，不负责生成配置、密钥或校验 TLS。
- `src/readiness.ts`：检查现有 SSH 账号在 Linux/macOS 是否能无交互 `sudo`；并不注册账号或安装公钥；Windows 明确未实现。`src/registration/linux.ts` 只生成计划，apply 始终阻止执行。
- `src/session/tmux.ts`：构造 tmux SSH 命令参数，未实机验证；不保证机器重启后会话存续。
- `src/agent-bus.ts` 和 `src/server.ts`：实验性 SQLite Agent 心跳与消息持久队列，内置 Bun HTTP 监听，默认 `0.0.0.0:8787`、共享 bearer，无 TLS。接受仅表示存储，消费可能重复；同一 token 可冒充任意 Agent。只能在可信网络或正确配置的 HTTPS 反向代理后面使用。
- `src/prime-bridge.ts`：Agent bus 的 TS 客户端，提供显式 heartbeat/send/pull/ack；尚未接线进 Prime 内部消息。
- `src/storage.ts`：单独的机器/留言 SQLite 存储，尚未接进控制面。
- `docs/architecture.md`、`docs/transports.md`：需求、限制、候选和链接。

## 已验证（仅本机）

Bun 1.4.4；前一已推送版本 `bun test`：42 项通过；`bun run typecheck`：通过。后续改动的实际测试结果以最新提交为准。测试包括本地 socket 和 mock，不证明真实 SSH、UU、rathole、Windows/macOS 或互联网可用。实验中曾复现反向中继背压和关闭丢数据；当前测试已覆盖部分回归，但实际网络背压和异常语义仍需审查。用户明确不需要 CI；原 GitHub Actions 工作流已移除。以本地测试为准。

```bash
cd ~/projs/envinhands
export PATH="$HOME/.local/share/envinhands/bin:$PATH" # 当前机器上的 Bun
bun install --frozen-lockfile
bun run typecheck
bun test
git status --short --branch
```

## 用户目标和未完成的高优先事项

1. Prime Agent TS 0.9.8 与本项目实际接线；验证 Agent 跨机器发现和收发，不能把本机跨 daemon 能力当成跨机。
2. 节点安装注册：本机确认配置 SSH 公钥和团队管理员访问。Linux/macOS 必须验证 `sudo -n true`；Windows 必须验证实际管理员令牌。私钥和管理员密码不上传。当前只有检查组件，没有配置流程。
3. 集成真实 rathole/wstunnel/frp、UU 等后端，探测实际状态并尝试回退；分别检查许可证和服务条款，绝不默认其已可用。
4. SSH 本地代理/CLI、WSS/TLS、身份与主机密钥、持久化、自动重连、闲置超时、限流和清理。tmux 只提供远端会话保留，断线期间命令是否执行仍需应用确认。
5. 覆盖真实 TCP 背压、半关闭、中继重启、断网、休眠、长时间 SSH 及三平台的端到端测试，记录不可恢复的失败。
6. 增加 Agent 活动、机器留言持久化及运行态观察，区分状态过期与不可见的 Agent。

## 恢复工作

先检查两仓库最新远端分支和工作区，不要覆盖已有修改。`envinhands` 的共享节点能力、后端进程封装和 UI 均尚未真正接线，文档中的所有候选均不是可部署承诺。网络差时优先保存源码与本文件，再重新尝试获取 Prime Agent fork。
