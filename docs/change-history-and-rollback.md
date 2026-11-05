# 接手后的体系演进与回退记录

本文随阶段更新，最终验收后补齐。使用手册见operations-manual.md；本记录不含密钥、运行时二进制、真实业务数据库或私人凭据。

## 接手基线

- EnvInHands：`3d733935c5f2aa8106504c23cafc13404211171a`，main。已有机器/消息SQLite、relay/node/proxy、register/tmux CLI及skills；自动公钥/admin配置仍阻止apply。
- Prime fork：`e398494ebbe70168f0bc15cef8e8c6810d9b2f74`，0.9.8+fork.4。已有opt-in heartbeat/messages/resources三个适配。
- Windows无Bun/依赖；控制VM Debian12.15已SSH可达，但sudo-n失败，项目尚未部署。旧Linux137项是历史结果，不当成本机证明。

## 按提交的演进

| 仓库/提交 | 实际改动 | 验证/兼容与回退注意 |
|---|---|---|
| Env `5b8deaf` | 提取复用HTTP边界；不可变Agent注册与追加修改记录；离线spool；本地/远程受审计执行；真实SSH探测/候选回退；客户端身份/路径TTL；外部Prime审计适配与独立进程脚本；修平台测试和文档漂移 | 169pass/typecheck通过，实际CLI编译/VM版本测试/relaySSH。新增agent_registrations/change_records表，不改原消息wire。回退代码不删除新表；旧版本忽略新表，但新客户端会失去新增API，不应继续调用或误认同步成功。 |
| Prime `61a643b` | 修真实源码loader缺dist解析；Windowsjunction与本地Vitest启动；resources策略测试确定性化并迁出optional真实API用例；文档更新 | 正常hooks/fullcheck/policy/真实loader13项及seed通过；原manifest/lock不变；三旧适配仅格式化且编译等价。回退会恢复fresh-source加载故障，不需要Env业务退回Prime。 |
| Env `1fe9e56` | portable collaborate CLI/client；真实Prime CLI/daemon/session模型工具循环验收；配置化execution外部适配；返回实际命令output；validation-onlyPrime源码导出器 | 171pass/typecheck；3真实CLI→VM脚本provider正常使用实测。实际模型另有后续报告，不把该提交写成当时已真模型验收。核心不依赖Prime；回退新CLI入口需要同步退相关使用文档/调用端。 |
| Env `7aee3e8` | spool按registration+operationId先durable预留，防已开始任务重试/重启后重跑 | 171pass/typecheck；journal在spool/operations，回退时保留，不删除以“恢复重试”。网络push首失败reset有原件；之后正常push成功。 |
| Env `a3c0e42` | 有序 flush/真实 pending、准备期取消、Prime 工具事件观察与只读文件、统一设备登记/失败 inventory、正式 SSH access API/CLI，以及真实模型协作/CTF、运维手册 | Windows 181 pass；精确 123 文件 Linux 副本 180 pass/1 skip/0 fail，两端 typecheck 0。源码与锁未变。新增 includeNotReady 查询需对应服务；旧服务未升级时不能假定支持。撤回本提交前保存本地 spool/operations 和全部记录，协调停用新增客户端入口，保留 SQLite 数据。网络失败原件已保留；之后正常 push 成功，远端完整 SHA 与 a3c0e42 一致。 |

## 本阶段实际结果

本阶段已实现并实际验证：正常并发flush pending、intent/outcome顺序及准备阶段取消；自动Prime工具事件观察；只读本地共享资源；真实gpt-6.1-terra三CLI协作与自建CTF全员自然协商100分；管理主机Linux/Windows设备登记与显式inventory；Linux/macOS/Windows统一登记入口；可配置SSH远程access API/CLI实际VM200。功能提交为 `a3c0e426f82dca07498975811921ce1e2dca23ce`；原始目标缺项与证据见 goal-conformance.md。

## 交付核验与文档校正

`a3c0e42` push 已由远端完整 SHA 核对。按最初交接、design/protocol 和后续要求重新列出逐项目标状态，并修正 README/HANDOFF/quickstart 的历史描述。隔离 SQLite 一致性备份→新路径恢复→两次独立服务重启已通过，机器/心跳/消息 ack/note/注册/change 全字段核对一致；没有生产库切换，详见运维手册 10.3。另以全新 Prime agentDir 在 Env 工作目录自动发现两个原始项目 skill，正常资源加载路径及正文读取 exit 0，无模型调用、无 skill 改动。这里是文档和实际验收补录，不改变功能代码或数据库 schema。

## 推送后独立复核修复

用户要求继续核对原始与后续要求。三方读取原始目标、源码及报告后发现正常启动自动观察配置缺口、相对 edit 资源路径歧义和 NAT/历史状态措辞过大。本次新增正常 `prime-profile` 配置片段生成器（只输出，不覆盖 settings）；用无关 workdir/新 agentDir 的实际 Prime 正常 loader 核对七扩展、观察 handler 与两原 skill。标准 CLI 验收脚本不再仅 CTF 加观察。已知 edit 按真实 ctx.cwd 得绝对资源引用，两个同 host 不同 workdir 回归与实际 SDK 通过，首红保留。其余工具不猜因果；没有扩大为全局监控。

修改 messaging skill 的过时跨机描述、标明旧401/design现状快照为历史，并收窄 NAT/技能使用/身份引用 hash/live版本结论。没有改 package/lock、Prime平台、公钥、权限、live服务或数据库。撤回本次时删除新增 profile 调用/配置列表并恢复相应适配版本；保留已产生的绝对资源记录，不将它们改写回相对路径。旧模型验收不被追溯声明使用新 profile。

## 依赖和配置变化

- Env原package.json/bun.lock未新增第三方依赖。Bun1.4.4在用户目录准备，官方release digest/SHASUMS核验，不改系统PATH。
- Prime原npm lock+workspace manifest冻结，npmci --ignore-scripts，未通过build制造dist。
- VM用户态Node24.14.1与tmux3.3a/必要so供验证，未系统安装、未改sudoers/SSHkey/防火墙。它们不是Env核心全部运行前置。
- 实际模型与Env共享token只进受限配置/进程环境，API密钥不进Git；换key是配置更新，不是代码revert。

## 安全的阶段回退流程

1. 先确认问题属于客户端代码、服务代码、配置还是数据。保存当前commit、部署manifest、运行参数非敏感引用和故障记录。
2. 停止本次部署拥有的服务/客户端，等待自身工作结束，避免混合版本继续修改。不要关闭别人的进程或全部tmuxsession。
3. 对SQLite使用其backup接口或在停止写入后复制完整数据库备份；WAL运行时不能只复制主文件当一致备份。spool与operationsjournal一起保留。备份/复制本身也署名。
4. 共享main优先`git revert <目标提交>`产生可审计修复提交，不forcepush或reset覆盖历史。多个依赖提交按逆序检查，保留新表/记录再退代码；不直接删审计或消息数据。
5. 用旧部署的精确源码/lock/runtime快照重建隔离目录，验证需要的CLI/API，切换受控服务引用。不要在现有dirty工作树盲覆盖。
6. 验证目录、队列、未确认消息、注册署名和待同步spool仍可查询。结果未知的远程命令先核对，不因回退而重跑。
7. 记录实际rollback范围、before/aftercommit/配置/DB备份引用、执行Agent、结果，再按正常质量门槛commit/push。

## 优化方向与完成口径

稳定小核心、CLI/Prime/其他接入复用，不用多层兼容兜底。原始目标未全部完成前持续列出：逐指定Agentadmin正向、所有者批准的自动配权/撤销、真实mac和六设备、异地多故障域入口等。实际正常路径已可用直接认可，但不拿CTF拿分替代全部目标。
