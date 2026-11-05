# 当前环境验收报告与完整目标对照

## 结论

**当前获准 Windows↔Debian VM 正常协作范围通过；原始六设备、逐指定身份管理员与实际异地验收尚未全部通过。** 本报告不是“全部项目完成”证书。它保留最初三人六设备/Prime TS0.9.8目标，以及后续自然协商CTF、所有修改署名、不同主机工作互访互改、解耦复用、运维回退与及时push要求。

最终复核重新读取了 Desktop/1.txt、handoffs/01-envinhands-lead.md、docs/design.md、docs/protocol.md 和后续 handoffs/06/07/09。设计中的长期资源图/联邦/聚合仍是演进项，不擅自增加首版门槛；已确认的六设备/每身份管理员/异地要求也未被降格为非目标。

## 1. 精确版本与原生结果

| 对象 | 实际版本 | 结果 |
|---|---|---|
| EnvInHands 最后功能源码 | `ba9a9d289eb1adb18799e18b2d597c7c1aa0d6c9` | 正常push，root独立ls-remote完整SHA一致 |
| Windows Bun1.4.4 | 同上源码 | **221 pass / 0 fail**；typecheck0 |
| Debian12.15 amd64 Bun1.4.4 | 精确186文件源码包，SHA256 `5468065234fe91f735d7c850f445d02ef5aa6308f42409c93f09b2438e050056` | **220 pass / 1 skip / 0 fail**；typecheck0；源码/manifest/lock前后哈希不变 |
| 唯一Linux skip | 外部Prime heartbeat直接导入可选测试 | 该独立副本无外部checkout，不报221全通过；真实Prime由下述单独证据验证 |
| 编译Env CLI | Windows与Linux实际单文件构建 | 实际hosts命令通过；原生helper隔离文件效果另有编译程序实测，不只build/help |
| Node客户端 | Node24.14.1+项目tsx | 实际纯model/client导入与构造/hash通过；Windows实际两host发现/读取通过，不加载PS资产 |
| Prime fork | `88b7d8cbc137fd307f29aa51edac3e472ea174ff`，0.9.8+fork.4 | 正常hooks/push，root独立远端SHA核对；Undici/MCP/ZIP/两精确override分提交验证 |

当前资源服务运行的是 `280189662f4968259744c23cfedc6de796079e77`。它与ba9a9d2的差异是纯客户端协议模型提取及文档，不能声称运行服务已自动换源码。最后Node客户端/正常Prime用新模型代码访问这些服务正常。原早期5b8deaf控制bus保持独立，未被资源服务升级覆盖。

## 2. 真实使用验收

| 场景 | 实际做法与结果 | 边界 |
|---|---|---|
| 多真实模型Agent协作 | 三个独立Windows Prime CLI/daemon/session/工作目录/Agent ID，实际gpt-6.1-terra工具循环完成消息处理环及资源经验 | 三开发会话不是被测客户端；同Windows多实例不冒称三处网络 |
| 自然分工CTF | 不同用户约束，无固定负责人/不提供flag，Windows静态源与VM动态probe/scorer分离；三个真实模型Agent均实际工作，评分100 | controller安排继续轮次，不承诺完全无人调度；这是获准自建题 |
| 不同主机工作互读互改 | Windows与Debian不同文件，各自被对方read→expected-hash write→readback，两端独立物理磁盘和署名/hash一致 | 只明确sharedRoots，UTF-8单文件≤64KiB，不是任意全盘/二进制同步 |
| 真正VM Prime修改Windows | Debian完整Prime CLI PID6213/session01a1ad7a-c576-7253-83c3-640685801078，三actual prompt/Agent/tool/agent_end完成读改读；Windows独立盘216bytes/SHA b97c594d...a4b97一致 | 零费用脚本provider证明真实运行路径，不冒充新真实模型智能；Python REPL未在VM证明可用 |
| 正常profile冷启动组合 | 原Node+tsx controller→完整Prime CLI PID8332/session01a1adbf-9e54-7198-95a3-b51ab7b8e7ec，新空配置正常7Env扩展/2skills，不禁skills/builtins；8实际Agent工具turn发现/目录/读两host/inspect原op通过 | 0工作文件写/0paid；skills命令与有效prompt包含已核，不声称模型阅读全部正文 |
| 便捷多host发现 | 私有host catalog列ID→资源ID→当前层目录→返回name读取，一个实际session不切endpoint环境 | 最多100项有hasMore，无递归/无绝对root泄露；endpoint由操作员配置，不信远端消息授权 |
| 未知写核对 | 实际Windows→VM新文件只写1次后fixture丢回复；caller返回unknown+hostId/op；原目标inspect读到unknown/success并readback；独立VM磁盘110bytes/hash8d4a5e...2352一致 | 未把unknown当未执行；无第二write，409明确conflict；查询有界且nextAfter继续 |
| 权限保持 | Unix0750脚本CAS改后仍0750；Windows普通继承与protected DACL源/编译首次替换均保留owner/group/exactDACL语义，仅规范0x400继承bookkeeping | 不copysetuid/setgid；不是对抗外部恶意并发写的OS沙箱 |

## 3. 连接、恢复与修改记录

- 正式 `service` 私有配置保留，两个真实OS进程停止/复用配置与DB重启通过。本轮owned服务e4d→280升级前备份自造DB/config/source引用、原7表全部行与工作hash保持；原旧控制服务未读停。回退资料已留，**未假称已执行生产rollback**。
- `access` 固定local53611与 `publish` 固定受信入口loopback45321均用正式profile实际stop→确认不可达/端口关闭→sameprofile重启→原catalog/消费者配置不改读取恢复。发布等待真实OpenSSH forward-success；后端以认证HTTP验证，无公共bind/sshd/firewall修改，不提供无基础设施NAT魔法。
- 严格hostkey/实际SSH探测与失败候选回退通过，开始的远端任务不换路重跑。relay v2显式版本、方向FIN/ACK，EOF后1MiB回包/反向FIN/排空/提前关闭拒绝通过；实际Windows编译proxy经加密承载→新VMrelay/node→真实sshd返回1000/Linux退出0。新v2fixture已按精确PID正常释放，私有config0600保留。
- Unix tmux正常detach/reconnect与实际自有SSH客户端SIGKILL后新连接重附着，同workerPID6836存活；核对后清理自有session/worker。不是主机重启或任意异地网络保证。
- 完整自造fixture配置/sourceRef/DB/工作文件/spool+operations恢复通过：两进程6988/7007，原pending2→0，journal hash未变，原operation重放callback0。路径重写后config不是字节相同，逻辑/token相同；非生产secret迁移/掉电/并发压力。
- 正式服务写API要求注册声明，持久intent在effect前、result在后；CLI/Prime实际session署名、knownedit前后hash、同目标inspect均实测。共享bearer标签是声明，不是密码学身份。外部/系统/绕过适配的写入仍需显式留记录；不将tool观察误称全盘因果捕获。

## 4. 原始目标仍未闭合的内容

| 项目 | 状态 | 必需的实际下一输入/工作 |
|---|---|---|
| Linux desktop、目标Intel NAS、三台Mac及完整六设备 | 受阻 | 提供所有者批准的真实设备接入/测试窗口，逐台平台/架构/休眠与tmux实测。Windows/VM/fixture不外推 |
| 每个指定Agent自己的SSH/admin正向 | 受阻/部分完成 | 逐设备Agent身份与实际公钥指纹、hostkey、路径、管理员权限范围与所有者确认；从每个实际客户端执行。当前真实sudo-n失败，正确not-ready已存VM，不能靠标签/服务身份替代 |
| 真实所有者批准的配权/撤销 | 实现部分完成 | Unix/Powershell本机确认apply/owned revoke已真实隔离效果测试，但未对真实keys/sudoers/groups应用。需已有合法管理员上下文和逐设备实际SSH复验；自定义sshd、Mac实机仍缺 |
| 两实际地点与独立可用入口 | 受阻 | 提供共同可达获准加密入口与另一站点设备；实际发现/任务/署名同步、入口中断后新连接回退，记录共同故障域。当前Windows↔VM同宿主不冒称 |
| 全部修改路径的署名要求 | 部分完成 | 当前受控API、文件/执行工具与本轮部署有记录；任意外部程序/系统修改不是自动全局监控。新增修改入口继续接明确durable边界，不能把这一要求说成彻底实现 |
| 长期部署/生产安全 | 部分完成 | 当前正式配置与重启/备份恢复可用；未安装开机服务、未做所有故障/容量/生产TLS演练。Prime仍有Windows22/Linux23依赖告警含1critical；已分类而非证明本路径可利用/无风险 |

当前剩余critical是proxy-addr经MCP SDK的Express服务器分支，已验路径为SDK客户端与Env Bun API；未见该trust-proxy IP判断分支实际用于本验收，但不因此宣称零风险。对陌生workspace自动加载扩展也需遵守信任边界。未为数字好看擅跑auditfix或大版本升级。

## 5. 可接手文件与证据

- [正常操作一页流程](normal-workflow.md)
- [完整运维手册](operations-manual.md)
- [逐项目标及E1–E34证据索引](goal-conformance.md)
- [从接手基线到当前的演进与回退](change-history-and-rollback.md)
- [入口发布与稳定访问](control-ingress.md) / [共享文件](shared-files.md)
- 工作区 `handoffs/12-current-runtime-manifest.json`：实际运行PID/源码版本/私有config引用/清理边界，不含凭据值。
- 最终Linux：`handoffs/evidence/vm-ba9a9d2-20261105T220927Z/VM-BA9A9D2-CLIENT-GRAPH-VALIDATION.md`。
- 正常完整CLI：`prime-agent-resume-20261105T173812935010Z/normal-cli-two-host-readonly-20261105T220222528418Z/after-client-model-split/`。

原始失败、修正、源码冻结hash、实际exit都保留；后来的通过没有覆盖失败原件。按Conventional Commits逐阶段推送、无force/amend/CI新增。最终文档提交号由包含本文的实际Git日志确认，不能在本文虚构自身commit。**当前范围认可可用，完整项目的外部/未实现项仍按第4节继续，不以本报告缩减目标。**
