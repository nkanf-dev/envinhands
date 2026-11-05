# 初始目标对照与验收状态

本表保留最初目标，不以近期 CTF 或局部测试替代全部交付。复核来源：用户最初三人六设备目标、Desktop/1.txt、handoffs/01-envinhands-lead.md、仓库 docs/design.md 与 docs/protocol.md，以及后续关于真实 Prime 实例、真实模型、修改署名、异地接入、解耦复用和交付手册的要求。这些原始资料已在本阶段再次读取。

状态含义：**已实测可用**仅指下表明确的正常使用范围；**部分完成**表示已有成果但原目标未闭合；**未完成**表示功能或演练尚未交付；**受阻**表示需要尚未提供的实际环境或授权。未来资源图、联邦和多路径聚合仍是演进方向，不擅自升为首版门槛，也不把已确认的初始目标移入“非目标”。

## 逐项结果

| 目标 | 状态 | 实际结果及证据 | 还需完成 |
|---|---|---|---|
| 多真实 Prime 客户端对接 VM | 已实测可用 | 三个 Windows 独立 CLI/daemon/session/工作目录与 Agent ID，经加密路径访问 Debian 控制 VM；真实 gpt-6.1-terra 工具循环完成处理消息环。E1 | 本机多实例不是三台异地主机。 |
| 不同用户自主协商，无固定负责人 | 已实测可用 | 三位 Agent 分别受 Windows 静态源只读、VM 动态执行、独立复核要求约束，自主发消息分工；自建获准 CTF 评分 100，全员均有有效工作。E2 | 这是实际模型正常工具循环，但 controller 仍按轮提供继续机会，不是完全无人调度；运行时关闭 skills/内置工具，与 E14/E15 的独立 skills 加载证据不能合并。不承诺任意题或无授权资源。 |
| 三人六设备与 Intel/AMD 兼容 | 受阻 | Windows x64 与 Debian VM amd64 已运行；Linux 原生采集已核对。E3、E4 | Linux desktop、Intel NAS 实机、三台 Mac、各自网络尚未逐台验收；兼容代码不等于硬件实测。 |
| 设备元数据登记到管理主机 | 已实测可用 | Windows/Linux 原生信息实际登记，API 与独立 SQLite 读回 pending；device register 共用采集路径，macOS 有映射 fixture。E4、E5 | 这里只是元数据，不称最终“注册成功”。macOS 真机仍缺。 |
| 所有者确认后的公钥/admin 自动配置与撤销 | 部分完成 | 旧 Linux 助手仍为计划；新增 runUnixRegistration/provision 已实现 explicit confirm、现有管理员上下文、owned receipt 的 key/sudoers 应用与撤销。Linux 真 Python/visudo 隔离效果测试通过，真实系统未应用。src/registration/apply.ts | Unix 实际文件效果/部分撤销已测；真实设备仍需所有者授权并以自身身份验 SSH/admin，不能以隔离 fixture 说已配权。Windows 原生 helper 也已实现 owner-confirmed apply/owned revoke，真实 NTFS 文件/ACL 的隔离 fixture 通过；组操作只 fixture mock，真实管理员上下文/自定义 sshd 及 Mac 实机仍未验证。 |
| 每个目标 Agent 自身 SSH 与管理员验证 | 部分完成 | 实际身份/session/route/TTL 客户端检查、严格 host key、真实普通用户 SSH；sudo 不足正确 not-ready。E6 | 不能用服务端身份替代其他 Agent。指定身份逐一授权、正向 admin 验证未完成；当前 VM sudo -n 失败。sshIdentityRef 已改实际 OpenSSH 公钥 SHA256，前后指纹变化不 ready；服务持久 /v1/access-evidence 按注册/session/target/route/key/user 保存声明观察，latest 负向盖旧正向，不升全局 machine ready。实际 Windows 主控使用既有获准key/严格hostkey登录、真实sudo-n失败并按该公钥指纹/session存入当前VM API，not-ready已实际读回；正向管理员授权仍缺。 |
| Windows 实际 SSH 管理员令牌 | 受阻 | 固定命令检查有效令牌的代码和 mock 通过，非仅检查组成员。test/windows-readiness.test.ts | 需获准 Windows SSH 会话与真实管理员身份；尚未实测。 |
| NAT 主动出站目标与受控 relay SSH 通路 | 部分完成 | Windows 编译 proxy→加密承载→VM relay/node→同 VM 真实 sshd，错误 secret/host key 拒绝；受控字节通路实测成功。E7 | 还不是独立 NAT 站点仅出站接入共同外部入口；异地、多故障域、入口断开与恢复未闭合。 |
| 多入口真实探测及新连接失败回退 | 部分完成 | 严格 SSH 实探测与候选失败后成功路径已跑通；开始的命令不换路重跑。E6、src/transports/ssh-routes.ts | 两个真实异地/独立故障域后端、入口中断恢复和站点换网还未完成；UU/rathole 只有进程适配。 |
| 三位异地成员的共同加密入口 | 受阻 | 正式客户端本地 access 桥接 API/CLI 用已有 SSH 路由连接远端 loopback 控制服务，Windows→VM 请求实际 200。E8 | 需实际可达的获准 SSH jump、VPN 或 TLS 入口；不会无基础设施凭空穿透 NAT，不自行开放公网端口。 |
| 发现、活动、消息和经验共享 | 已实测可用 | 真实 Prime 环与 CTF 完成目录读取、活动、send/pull/ack 和资源经验；消息接受/已处理严格区分。E1、E2 | 心跳只表示近期观察，不保证在线/空闲或资源锁；完整资源图、容量治理另列演进。 |
| 不同主机不同工作内容互读、修改与共享 | 已实测可用 | Windows↔Debian 各不同工作文件，真实 SharedFilesClient read→expected-hash write→readback，两端资源主机独立读盘与署名/hash核对；Windows真实 Prime loader/runner/wrapped工具也实际修改VM并读回。E17。原CTF只读/动态执行证据另见E2 | 当前明确共享root内 UTF-8单文件≤64KiB，非任意全盘/二进制同步，不等于异地站点；长期job索引另缺。 |
| Unix tmux 保留工作现场 | 部分完成 | 严格 SSH PTY 正常两次 detach/reconnect 后同 worker PID；另实际强制终止自有SSH客户端，重连附着同workerPID6836仍存活，核对后清理自有会话/worker。E9、E22 | Mac、全部客户端 TTY、真实异地链路故障、主机重启不在证据内；不保证原 SSH 迁移或主机重启保活。 |
| 本地/远程修改有注册与 Agent 署名 | 部分完成 | 不可变注册、intent/outcome、离线 spool、明确同步；实际 CTF 三 Agent 均有服务端观察记录。E10 | 签名为声明而非密码学身份。工具事件不等于逐文件因果；正式服务统一 API intent/outcome 严格署名，device/collaborate/files 写 CLI 显式 Agent/session；正常 Prime 签名 transport 先加载，knownedit 有 cwd 绝对路径及实际前后 hash。三真实 CLI 严格服务零模型付费运行各自 API/tool 记录已独立读回。工具外/系统/部署仍需显式记录，不声称全资源自动捕获。E1 历史只显式记录/E2观察，不能追溯改写。 |
| 持久化、消息重启恢复与不盲重放 | 已实测可用 | HTTP/SQLite、幂等发送/冲突、重复 pull/ack、重启测试；持久 spool/operation reservation 保留未知结果。E3、src/change-spool.ts | 实际长期运营、容量/归档、全部故障边界不由测试通过推定。 |
| 一致性备份与恢复演练 | 已实测可用 | a3c0e42 隔离 fixture 经 VACUUM INTO 备份、新路径恢复，两次独立服务重启，API/SQL 全字段相等、三库 integrity ok。E13 | 另完整新fixture已包含私有config/sourceRef/DB/工作文件/spool+operations恢复、新OS服务、flushpending0及拒operation重放callback0（E24）。不涉及生产 live 库、并发 writer 压力、掉电或定时备份。 |
| 轻量节点、解耦复用与便携运行 | 部分完成 | Env 核心独立于 Prime，CLI/外部适配共享核心，无新增 Env 第三方依赖；Bun 单文件与用户态运行时已用。E3、E7 | 全目标架构发布、安装包与内存/CPU 预算、长期服务/开机恢复尚未全面交付。 |
| Agent skills 与当前平台集成 | 已实测可用 | 全新空 agentDir、Env 工作目录经 Prime 正常 SettingsManager/DefaultResourceLoader 自动发现两个原始项目 skill，正文完整可读，diagnostics 为空，原文件 hash 未变。E14 | 这是发现/可读取，不声称模型已读取遵守正文或正文所有历史命令已复验。 |
| relay 完整流控与关闭语义 | 部分完成 | 实际 SSH 正常通路和现有限额可用。E7 | 新 relay v2 原生方向 EOF/1MiB 请求与响应/反向 FIN/输出排空及提前关闭拒绝已通过（Win focused24+root combined212/type0，Linux focused24）；完整175快照Linux211pass1skip/type0、Windows212pass/type0；Windows compiled proxy→加密承载→VM新v2 relay/node→真实sshd id/uname exit0已通过，不称旧服务已升级。生产容量/异地长期稳定另测。 |
| 服务/数据/配置回退与使用手册 | 部分完成 | 完整运维、阶段变更与回退说明已交付，区分代码、DB、凭据与 spool。E11 | 原 live5b8deaf 未动；正式服务经独立双进程重启、完整fixture恢复及owned版本切换到2801896，config/原记录/工作hash保持；Win/VM新inventory/catalog/inspect均正常，实际运行清单见handoffs/12。新独立服务承载双向共享工作；不是旧 live 自动升级、开机服务或整体系灾备。 |
| 两仓库 Conventional Commits 与及时 push | 已实测可用 | Env功能ba9a9d2与Prime88b7d8c已推送，root独立ls-remote完整SHA核对；中间提交/失败见E12及Git历史，后续修复阶段逐一保留。 | 网络首失败独立保留；包含最终验收报告的文档提交按实际回执确认，不虚构自身SHA。 |

## 当前最后版本

最后功能提交ba9a9d289eb1adb18799e18b2d597c7c1aa0d6c9：Windows221pass/type0；精确186文件Linux220pass1skip0fail/type0，源码/lock不变、编译CLI/Node纯client导入实测0。两host运行服务2801896，纯模型提取不倒写旧部署；正常完整Prime组合8实际toolturn已通过E34，最新全量结论见 [验收报告](acceptance-report.md)。

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

- **E15**：主控 normal-prime-profile-native-first.raw.log / .result.json、verify-normal-prime-profile.mts：新空配置/无关 workdir、正常 settings 加载七扩展/观察 handlers/两 skill，exit 0、无网络/模型；src/integrations/prime-profile.ts 与 docs/prime-profile.md。相对 edit 修复证据见 Prime ATTRIBUTION-RELATIVE-EDIT-DELIVERY.md，首红后绿及真实 SDK 绝对路径记录。
- **E16**：post-push-original-goal-root-review.json、Prime INDEPENDENT-GOAL-CONFORMANCE-REVIEW.md、independent-environment-conformance-20261105T195150Z/INDEPENDENT-ENVIRONMENT-VERDICT.md。推送后独立读取原始输入/源码/实际报告，明确实际开发缺口，不仅列硬件授权。

- **E17**：主控 cross-host-work-20261105T202717Z/ 与 vm-completion-20261105T202907Z/FORMAL-SERVICE-CROSSHOST-DELIVERY.md、windows-to-vm-independent-disk-audit.log：Debian→Windows 最终 dd4f3413...fcac，Windows→Debian 初次48b0fc4e...d36a，两端实际磁盘核对；actual-prime-sdk-cross-host-shared-work-first：真实SDK追加后1e5958c8...a660，最后独立VM磁盘170bytes与该SHA一致，实际SDKsession署名记录前后hash核对exit0。158文件源码冻结并非已commit；后加Prime adapter不冒称在VM158suite内。
- **E18**：主控 signed-strict-cli-no-model-result、strict-three-cli-audit-readback：3真实CLI PIDs11920/35464/28832，零付费provider处理消息/经验/签名；独立DB161records中三者均有API+工具观察。Unix lease UNIX-APPLY-DELIVERY.md、formal服务两PID重启和ACCESS-EVIDENCE-DELIVERY.md各自保留首失败。

- **E19**：prime-agent-resume-20261105T173812935010Z/vm-prime-cli-deployment/ACTUAL-VM-PRIME-CLI-DELIVERY.md：真实 Debian Prime CLI PID6213/session01a1ad7a-c576-7253-83c3-640685801078，三 actual prompt/Agent/tool/agent_end 完成 Windows 工作 read/write/readback；独立 Windows 磁盘216bytes/SHA b97c594d...a4b97 和服务实际 session 署名核对。零费用 scripted provider，不是新真实模型智能证明。Node/npm原锁453包，10manifest/lock不变；原锁npm报告29漏洞未处理，不称生产安全通过。系统Python无rlm，本任务未调用Python，不假REPL可用。
- **E20**：实际一 Prime SDK session01a1ad7c-5091-70d7-b1c1-3a76abb39a4e通过私有host catalog选择 Windows/Debian，读不同内容，无环境endpoint切换；actual-prime-one-session-two-host-selection.raw.log。目录API/CLI/工具发现的普通fixture通过，actual updated Windows服务catalog/list/read通过；跨机新端点实际 Debian→Windows listResources→list→按发现entry读取通过，216bytes/hasMorefalse/绝对root不暴露，原Windows磁盘不变；DEBIAN-WINDOWS-READONLY-DISCOVERY.md / debian-discovers-windows-38963-first exit0。
- **E21**：windows-registration-20261105T204730Z/WINDOWS-REGISTRATION-DELIVERY.md：原生Windows fixture真实文件/ACL/保留原keys/撤销2pass27expect，组/账户模拟且未真实配权，明确二次revokeAdministrator同意才撤本operation尝试范围，缺同意partial。首失败与修复独立保留；当前用户effectiveadminfalse，无UAC/提权。

- **E22**：主控 tmux-abrupt-20261105T2105* 对应 ABRUPT-SSH-TMUX-REPORT.json / actual-abrupt-ssh-tmux-first.raw.log：实际SSH客户端SIGKILL退出null、新严格SSH附着exit0，workerPID6836相同，不重复启动；owned会话清理exit0且worker不存在。不是主机重启或全网络故障演练。
- **E23**：owned-service-switch-20261105T210140Z/OWNED-SERVICE-VERSION-SWITCH.md：只本轮owned158 PID5390静默后备份自造DB/config/source引用，停止并以e4d同config/DB起新PID6718/44481，7表全行相等。主控实际旧路径unreachable→新严格forward恢复读170bytes/同SHA，无write重放；一个client配置发现两当前host资源/目录/文件通过。旧5b服务未触。

- **E24**：full-fixture-recovery-20261105T210440Z/COMPLETE-FIXTURE-RECOVERY.md：自造配置路径重写非byte相同、7表/API逻辑全等、原pending2→0、journal不变、callback0，两个独立service进程6988/7007正常退出。首外部copy目标已存在失败单独保留；非生产迁移/崩溃演练。
- **E25**：编译后 Windows helper fixture 实际apply/ownedrevoke exit0（compiled-helper-actual-direct-argv），完整compiledCLI hosts exit0；embedded-helpers-final-full Windows208pass/type0。helper源码资产内嵌后自有临时materialize，不把构建成功当外部helper执行通过；Linux精确173文件207pass/1skip/type0，实际compiledELF Unix隔离apply/revoke+真visudo通过exit0，完整compiledCLI hosts也通过。

- **E26**：vm-20b73e7-20261105T211339Z/VM-20B73E7-COMPILED-VALIDATION.md：精确20b73e7/173源码哈希不变，Linux207pass1skip0fail/type0；编译ELF实际helper文件效果通过，不是只build成功。Windows对应208pass/type0/compiledfixture同证据分开保留。
- **E27**：Prime fad44047ed8aac675c2a4a4f7a809a5c94c8a8d6 已正常hooks提交push并由root独立远端SHA核对，Undici7.30.1/MCPsdk1.32.0两同major升级，原报告中两包告警消失。OAuth40/Win网络loader34/Linuxtoolsinstaller101pass1skip/actualUndiciHTTP和两平台CLIhelp通过。原锁与新锁fixture分开；剩余Windows26/Linux27告警继续明确，不称生产全安全或将公告数量等同利用。

- **E28**：relay-v2-20261105T212022Z/RELAY-V2-DELIVERY.md 与 vm-relay-v2-20261105T213407Z/VM-V2-175-RELAY-HANDOFF.md：显式v=2整组，Win/Linux focused24（含方向EOF后1MiB回包/反向FIN/提前close），root全Windows212pass/type0、精确Linux211pass1skip/type0；首红与旧node-runtime fixture更新保留。relay-v2-compiled-windows-real-sshd-first exit0，实际1000/Linux，严格hostkey/原身份，无旧实例升级/WSS/异地声明。
- **E29**：Prime e263f1bd9e6f7fbac35359bda2c01425620c176b 已push且root独立完整SHA核对；只工具ZIP边界替换，先全成员预检后新staging写，六官方fd/rg ZIP实际提取与独立hash相符、未执行下载程序，Win/Linux helper+consumer16pass、正常check/loader/help通过。tar不变、无模型；仍有独立告警，不能宣称所有压缩包/异步reader.close错误已覆盖。

- **E30**：vm-filemode-20261105T214223Z/LINUX-SHARED-FILE-MODE.md：独立overlay真实0750脚本CASwrite后仍0750。windows-inherited-acl-20261105T215220Z/INHERITED-ACL-FIX-DELIVERY.md：仅忽略自动继承bookkeeping0x400，owner/group/ACE/DACL其余严格；ordinary+protected各首次替换成功，root消费者9pass/type0，源码与compiled product两类ACL实效通过。首ACL策略丢失及后续仅SDDL标记假失败分别保留，不退回rename。
- **E31**：cross-host-work-20261105T202717Z/product-fixed-access-reconnect.json 与 product-outbound-publication-reconnect.json：产品access同profile固定53611 stop/down/restart，catalog不改两host读取恢复；publish实际OpenSSH确认固定VM45321→Windows自有54559，认证资源发现/目录/读回，stop后端口闭合、同profile再起原consumer配置可用，无写重放。不自建公网/修改防火墙，不代表异地站点。
- **E32**：shared-write-operation-20261105T214721427159Z/SHARED-WRITE-OPERATION-DELIVERY.md 和 actual-vm-write-reply-loss-original-operation：caller在发前保留hostId+operationId，成功/conflict/unknown区分；files inspect/Prime inspect查询原目标，不误查默认origin。实际Windows→VM110bytes新文件仅写1次，真实响应被fixture丢弃后unknown→原ID查unknown/success→readback；独立VM物理hash8d4a5ea5...2352 exit0，无第二写。消费者type首失败与nativeACL集成失败均保留并已修后复验。

- **E33**：vm-2801896-20261105T215908Z/VM-2801896-VALIDATION.md：精确184文件/commit2801896全哈希核对，Linux220pass1skip0fail/type0，完整CLI编译并私有config hosts实际exit0；Win221pass/type0/compiled ACL ordinary+protected及发布实际入口证据另列。源码与锁前后不变；不把独立旧服务切换自动并入该gate。

- **E34**：normal-cli-two-host-readonly-20261105T220222528418Z/after-client-model-split/NORMAL-FULL-CLI-READONLY-DELIVERY.md：原Node+tsx控制器、实际Node完整Prime CLI PID8332/session01a1adbf-9e54-7198-95a3-b51ab7b8e7ec，新配置正常7Env扩展/2skills，无禁用skills/builtin；8个实际Agent工具turn发现并读两host不同内容、inspect原unknown/success。真实ctx与getstate一致、skills在command/systemprompt、0工作文件写/0paid。基线2801896叠加本轮pure-client-model修复，不倒写旧commit已含；首Node.ps1和Bun诊断缺tools失败保留。root修后nativeNode客户端两host实际读回、Windows全221pass/type0。

## 推送后复核结论

原目标未全部符合。可确认真实 Prime→VM 的协作/授权普通用户工作正常；不能把 pending 设备等同注册最终成功。独立复核所指的 Unix 应用/撤销、实际公钥身份+持久观察、direct CLI/API署名与正式服务重启已继续实现并实测其受控范围；不能把这一批新结果倒写为旧版已完成。仍有 Windows 真实管理员应用/SSH令牌正向、工具外修改边界、实际管理员正向、整体系生产恢复及永久服务等缺口。真实六设备、每身份管理员正向与两实际地点/两个可用入口还需获准环境。正常 profile 与相对 edit 定位是本次独立审查后完成的具体修复，不倒写此前模型报告。

下一步优先：1）保管已完成的正常配置、运行清单与回退资料（最终冷启动、两个主机owned版本切换和完整fixture恢复已实测，不能再列作未做）；2）确认各实际设备、指定Agent公钥身份及管理员授权清单，完成真实安装/撤销与逐身份正向验证；3）在获准共同加密入口下接入至少两个实际地点，做正常工作/署名同步及自有断线新连接回退。不要用重复付费 CTF 或增加泛化矩阵替代这些工作。

## 尚需的外部条件

1. 每个实际 Agent 的 SSH 身份引用、目标路径、已核对 host key，以及所有者对所需管理员能力的明确授权；不收集或转发私钥、密码。
2. 三台 Mac、Linux desktop 和目标 NAS 的获准接入条件；分别测试，不能用映射 fixture 外推。
3. 各地点共同可达的加密入口与站点测试窗口。节点可主动出站，但无任何共同路径时不能保证连通。

已跑通的正常路径可按上表范围使用；**原始目标尚未全部完成**。未来联邦目录、聚合、资源租约和无中心发现是研究项，不以其尚未实现否定当前成果，也不将其误标为已完成。
