# 初始目标对照与验收状态

本表保留最初目标，不以近期 CTF 或局部测试替代全部交付。复核来源：用户最初三人六设备目标、Desktop/1.txt、handoffs/01-envinhands-lead.md、仓库 docs/design.md 与 docs/protocol.md，以及后续关于真实 Prime 实例、真实模型、修改署名、异地接入、解耦复用和交付手册的要求。这些原始资料已在本阶段再次读取。

状态含义：**已实测可用**仅指下表明确的正常使用范围；**部分完成**表示已有成果但原目标未闭合；**未完成**表示功能或演练尚未交付；**受阻**表示需要尚未提供的实际环境或授权。未来资源图、联邦和多路径聚合仍是演进方向，不擅自升为首版门槛，也不把已确认的初始目标移入“非目标”。

## 逐项结果

| 目标 | 状态 | 实际结果及证据 | 还需完成 |
|---|---|---|---|
| 多真实 Prime 客户端对接 VM | 已实测可用 | 三个 Windows 独立 CLI/daemon/session/工作目录与 Agent ID，经加密路径访问 Debian 控制 VM；真实 gpt-6.1-terra 工具循环完成处理消息环。E1 | 本机多实例不是三台异地主机。 |
| 不同用户自主协商，无固定负责人 | 已实测可用 | 三位 Agent 分别受 Windows 静态源只读、VM 动态执行、独立复核要求约束，自主发消息分工；自建获准 CTF 评分 100，全员均有有效工作。E2 | 这是一个真实模型正常使用案例，不承诺任意题或无授权资源。 |
| 三人六设备与 Intel/AMD 兼容 | 受阻 | Windows x64 与 Debian VM amd64 已运行；Linux 原生采集已核对。E3、E4 | Linux desktop、Intel NAS 实机、三台 Mac、各自网络尚未逐台验收；兼容代码不等于硬件实测。 |
| 设备元数据登记到管理主机 | 已实测可用 | Windows/Linux 原生信息实际登记，API 与独立 SQLite 读回 pending；device register 共用采集路径，macOS 有映射 fixture。E4、E5 | 这里只是元数据，不称最终“注册成功”。macOS 真机仍缺。 |
| 所有者确认后的公钥/admin 自动配置与撤销 | 未完成 | Linux 注册助手生成预览；apply 明确 blocked，不会假报已配置。src/registration/linux.ts | 完成本机确认、安全应用、部分失败恢复与撤销；实际执行须有对应所有者授权。 |
| 每个目标 Agent 自身 SSH 与管理员验证 | 部分完成 | 实际身份/session/route/TTL 客户端检查、严格 host key、真实普通用户 SSH；sudo 不足正确 not-ready。E6 | 不能用服务端身份替代其他 Agent。指定身份逐一授权、正向 admin 验证未完成；当前 VM sudo -n 失败。 |
| Windows 实际 SSH 管理员令牌 | 受阻 | 固定命令检查有效令牌的代码和 mock 通过，非仅检查组成员。test/windows-readiness.test.ts | 需获准 Windows SSH 会话与真实管理员身份；尚未实测。 |
| NAT 节点主动出站与 SSH | 已实测可用 | Windows 编译 proxy→加密承载→VM relay/node→真实 sshd，错误 secret/host key 拒绝。E7 | 证据限当前 Windows↔VM 拓扑，完整公网及六设备另测。 |
| 多入口真实探测及新连接失败回退 | 部分完成 | 严格 SSH 实探测与候选失败后成功路径已跑通；开始的命令不换路重跑。E6、src/transports/ssh-routes.ts | 两个真实异地/独立故障域后端、入口中断恢复和站点换网还未完成；UU/rathole 只有进程适配。 |
| 三位异地成员的共同加密入口 | 受阻 | 正式 access API/CLI 用各自已有 SSH 路由连接远端 loopback 控制服务，Windows→VM 请求实际 200。E8 | 需实际可达的获准 SSH jump、VPN 或 TLS 入口；不会无基础设施凭空穿透 NAT，不自行开放公网端口。 |
| 发现、活动、消息和经验共享 | 已实测可用 | 真实 Prime 环与 CTF 完成目录读取、活动、send/pull/ack 和资源经验；消息接受/已处理严格区分。E1、E2 | 心跳只表示近期观察，不保证在线/空闲或资源锁；完整资源图、容量治理另列演进。 |
| Windows 静态资源与 VM 动态资源工作 | 已实测可用 | 只读文件适配、真实远程 probe/scorer、独立复核与实际输出。E2、E8 | 长期 job ID/断线结果索引仍未完成；未知任务不能盲重跑。 |
| Unix tmux 保留工作现场 | 部分完成 | 严格 SSH PTY 正常两次 detach/reconnect 后同 worker PID，清理仅自身会话。E9 | Mac、全部客户端 TTY、突发断网、重启不在证据内；不保证原 SSH 迁移或主机重启保活。 |
| 本地/远程修改有注册与 Agent 署名 | 部分完成 | 不可变注册、intent/outcome、离线 spool、明确同步；实际 CTF 三 Agent 均有服务端观察记录。E10 | 签名为声明而非密码学身份。工具事件不等于逐文件因果；绕过适配的外部写入仍需显式记录，不声称全局监控已完成。 |
| 持久化、消息重启恢复与不盲重放 | 已实测可用 | HTTP/SQLite、幂等发送/冲突、重复 pull/ack、重启测试；持久 spool/operation reservation 保留未知结果。E3、src/change-spool.ts | 实际长期运营、容量/归档、全部故障边界不由测试通过推定。 |
| 一致性备份与恢复演练 | 已实测可用 | a3c0e42 隔离 fixture 经 VACUUM INTO 备份、新路径恢复，两次独立服务重启，API/SQL 全字段相等、三库 integrity ok。E13 | 不涉及生产 live 库、并发 writer 压力、掉电恢复或定时备份；凭据与 spool 独立保管。 |
| 轻量节点、解耦复用与便携运行 | 部分完成 | Env 核心独立于 Prime，CLI/外部适配共享核心，无新增 Env 第三方依赖；Bun 单文件与用户态运行时已用。E3、E7 | 全目标架构发布、安装包与内存/CPU 预算、长期服务/开机恢复尚未全面交付。 |
| Agent skills 与当前平台集成 | 已实测可用 | 全新空 agentDir、Env 工作目录经 Prime 正常 SettingsManager/DefaultResourceLoader 自动发现两个原始项目 skill，正文完整可读，diagnostics 为空，原文件 hash 未变。E14 | 这是发现/可读取，不声称模型已读取遵守正文或正文所有历史命令已复验。 |
| relay 完整流控与关闭语义 | 部分完成 | 实际 SSH 正常通路和现有限额可用。E7 | 现 relay 不支持透明 half-close；完整慢端/溢出/关闭错误与生产容量尚未达到设计目标。 |
| 服务/数据/配置回退与使用手册 | 部分完成 | 完整运维、阶段变更与回退说明已交付，区分代码、DB、凭据与 spool。E11 | 更新本阶段最终提交/push 回执，实际部署切换与完整回退演练未执行。 |
| 两仓库 Conventional Commits 与及时 push | 已实测可用 | Prime 61a643b 已推送且干净；Env 5b8deaf/1fe9e56/7aee3e8/a3c0e42 已推送，git ls-remote 完整 SHA 核对 a3c0e42。E12 | 网络首失败独立保留；后续文档提交仍按实际回执核对。 |

## 可核查证据索引

这里给出交接证据的文件名，原始报告保存在本次交付工作区的 handoffs/evidence，不把未发布的文件伪装成 GitHub 链接。报告可能包含模型原始对话，仅在获准范围保管；不提交密钥或私有运行配置。

- **E1**：envinhands-development-20261105T180118486512Z/actual-cli-vm-real-model-complete.report.json；对应入口 scripts/prime-cli-validation.mts。
- **E2**：同目录 ctf-all-users-real-model.report.json、ctf-all-user-summary.json；入口 scripts/ctf-scenario.ts。
- **E3**：同目录 team-platform-final-full.raw.log / .result.json（Windows 181 pass）与 team-platform-final-types；Linux 见 vm-a3c0e42-20261105T192507Z/VM-A3C0E42-VALIDATION.md（180 pass/1 skip/0 fail）。123 文件 archive SHA256：769f6c4a2572f5e03e72542e4af8fc96bde855eb0ae340b7b2add8c65644abab。
- **E4**：同 Linux 报告与 linux-native-device-first；原生采集是纯观察，不把该项当成真实 HTTP 登记。
- **E5**：主控证据 windows-control-device-first.raw.log / .result.json；Linux 控制主机登记与独立 DB 读回见环境协调交接 04/05 对应回执。
- **E6**：主控 real-client-access-first、实际 SSH route/fallback 和 remote execution 回执；源码 src/client-access.ts、src/transports/ssh-routes.ts。
- **E7**：主控 real-relay-ssh-first/second.raw.log 与 .result.json（首失败保留）；Windows 编译产物真实 sshd 验证。
- **E8**：主控 product-remote-access-first、actual-product-access-cli-first.raw.log / .result.json；源码 src/remote-access.ts、src/remote-access-cli.ts。
- **E9**：环境协调 handoffs/04-environment-integration-status.md、05-debian-vm-feasibility.md 中的 tmux 实测与对应完整 raw/exit。
- **E10**：主控 ctf-real-participant-attribution.raw.log / .result.json：Dana 5、Ellis 10、Frank 7 对 intent/success 观察；不把这些数量当作每个文件都被审计。
- **E11**：docs/operations-manual.md、docs/change-history-and-rollback.md 与 operations-manual-20261105T191925Z/OPERATIONS-MANUAL-DELIVERY.json。
- **E12**：Git 历史与主控 team-platform-stage-commit、team-platform-stage-push-final、team-platform-stage-push-retry-* 原始日志。失败与后续成功分别保留。

- **E13**：vm-backup-restore-20261105T192959Z/VM-BACKUP-RESTORE-REPORT.md 与 verify-backup-restore.ts；修后正常路径 exit 0、独立 readonly 核对 exit 0；首失败独立保留。

- **E14**：prime-agent-resume-20261105T173812935010Z/skill-discovery-verification/SKILL-DISCOVERY-REPORT.md、verify-project-skills.mts、skill-discovery-node-first.raw.txt / .result.json；实际 Prime 0.9.8+fork.4 正常发现路径 exit 0，未调用模型。

## 尚需的外部条件

1. 每个实际 Agent 的 SSH 身份引用、目标路径、已核对 host key，以及所有者对所需管理员能力的明确授权；不收集或转发私钥、密码。
2. 三台 Mac、Linux desktop 和目标 NAS 的获准接入条件；分别测试，不能用映射 fixture 外推。
3. 各地点共同可达的加密入口与站点测试窗口。节点可主动出站，但无任何共同路径时不能保证连通。

已跑通的正常路径可按上表范围使用；**原始目标尚未全部完成**。未来联邦目录、聚合、资源租约和无中心发现是研究项，不以其尚未实现否定当前成果，也不将其误标为已完成。
