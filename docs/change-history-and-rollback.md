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

## 在制：正式服务、逐公钥证据与双向工作共享

后续用户要求继续所有可执行非硬件工作，并特别要求不同主机的不同工作内容能互读、修改和共享。本阶段新增：正式私有配置服务/稳定停止重启，统一服务 API mutation intent/outcome 与严格注册声明，直接 CLI 身份、session-bound signed transport，实际 OpenSSH 公钥指纹及持久逐 Agent access-evidence，knownedit 前后 hash，owner-confirmed Unix apply/owned revoke（真实系统未应用），明确 root 的共享 UTF-8 文件 API/client/CLI/Prime工具及 expected-hash 写入。

这些使用既有依赖与共同核心，未变更 Prime 平台、旧 live bus、现有 SSH key/sudoers/firewall。Unix helper 使用 Python 标准库与实际 visudo；隔离 Linux 文件效果测试不等于真实管理员已授权。共享服务新增 access_evidence 表和普通 API audit 记录；新严格服务要求已配置注册声明，旧 direct bearer-only 客户端需升级或显式保留 legacy 非严格模式（其原 actor unknown）。schema 保留，撤回客户端/服务时不要删除记录或重放任务。

此段记录实现演进，不预先承诺尚未返回的真实双向/VM完整结果。完整阶段 commit/push 与实际结果以最终回执更新，配置/DB/凭据与代码回退分开。

## `21d7831` 后：实际 VM Prime、资源发现与原生 Windows 注册

`21d7831` 已 push 并核完整 SHA；Windows202pass/typecheck0，精确164文件 Linux201pass/1skip/typecheck0（可选外部Prime直接导入skip）。两主机互改内容已闭合；后续又在 Debian 真正启动完整 Prime source CLI/daemon/session，三轮 Agent 工具读取/修改/读回 Windows 文件。零费用 scripted provider 与之前真模型 CTF 分开，最终 Windows216bytes/SHA b97c594d...a4b97 独立磁盘与实际 session 记录一致。原480文件 Prime export 原锁Linux安装，未构建或改锁；29条漏洞报告是未修的上游/原锁风险，不能拿安装成功掩盖。

本轮继续补共享 resource ID 与当前层目录发现（最多100/hasMore/noabsolute）、私有多主机host catalog（只输出hostId），普通 CLI/Prime一次session选择两个主机无需切环境。Windows native确认apply/ownedrevoke/ACL/explicit新撤权决定在隔离fixture实际测试；真实账户/组/sshd未动，仍不能说实际admin已验证。provision审计按action+operation分离reservation，grant与revoke能各记一次而不会把revoke误当重复grant。

目录发现是新增只读路由，旧158运行服务不支持；新独立Windows浏览服务实际可用，不伪称旧服务已热升级。host catalog及配置/ACL有凭据，不提交；撤回此轮客户端时保留配置引用和审计/receipt，不以删除记录恢复重试。Windows helper落地不隐含真实应用批准。

## e4ddb77 后的恢复与编译路径修复

精确 e4d Linux206pass/1skip/type0。获准仅本轮owned158资源服务切换到e4d，先记录零连接、备份自造DB/privateconfig/sourceRef，原表全行与配置保留；旧5b控制服务完全不触。实际旧后端不可达→新严格forward恢复读取同workhash、目录发现正常，无写重放。完整新fixture又完成config/DB/work/spool+operations恢复、flushpending0、原操作callback0。另实际SSH客户端强杀后tmux同workerPID恢复并清理。

编译检查发现原new URL helper路径对外部解释器不适用；改为text asset内嵌、短期自有脚本materialize并finallycleanup，未改helper权限/业务逻辑。Windows编译后的隔离apply/revoke与完整CLI主机列表实际通过。测试将累计4次PowerShell进程的独立既有key场景拆为单独test，避免默认5秒超时，不增加timeout或skip；首失败原件保留。回退包装器需同步发布原生helper文件，不能回退代码却漏发资产；历史receipt/operations不可删除以“修复重试”。

Prime原锁依赖审计是另仓库owner任务。原锁29报告不等于29已证exploit；undici/MCP获准同major修复与独立原生gate后另行提交，不把其未来结果混入Env此版本。未运行auditfix/改Env依赖。

## 两仓当前核验版本

- Env `20b73e796a33adf16170ee8cf5fdc1c83b45d120`：已push，Windows208pass/type0；精确173文件Linux207pass/1skip/type0；Windows与Linux编译后原生helper隔离实效均通过。运行中的资源服务版本仍按部署清单，不由仓库HEAD推断。
- Prime `fad44047ed8aac675c2a4a4f7a809a5c94c8a8d6`：正常hooks提交push，root独立ls-remote完整SHA一致；Undici7.30.1/MCPsdk1.32.0，只2第三方锁条目和2workspace声明，无其他transitive漂移。正常check、OAuth40、Win网络/loader34、Linux工具/installer101pass1skip及actualHTTP/help通过。剩余安全告警与条件路径另有审计，不宣称全清。

Prime此次依赖回退可revert该提交并用原锁重建独立目录，但会恢复对应已知告警；旧原锁VM验证副本未被改动。不能在live服务任意覆盖node_modules或将安全回退解释为需要删除Env日志/数据。两个仓库无CI改动、无force/amend共享历史。

## Relay v2 方向 EOF 与单 ZIP 边界

新增 relay-protocol.ts，relay/node/proxy 显式 `v=2`/registered-v2/ready-v2，二进制仍为opaque SSH。FIN/FIN_ACK只确认bridge排空/EOF；一向EOF不先关WebSocket，双FIN/ACK齐才正常关闭，提前endpoint1000也失败。保留限额/timeout，新增optional onRemoteEnd默认不end stdout。旧组件会拒绝，必须整组新部署，不自动fallback或声称旧SSH迁移。生产node-runtime不改，仅其直接测试peer的三个协议字面量更新。首红/首impl失败均保留。

Windows全212pass/type0；精确175文件Linux211pass/1skip/type0+hash不变。实际Windows编译proxy通过既有strictSSH加密承载→新VMv2relay/node→真实sshd返回1000/Linux/exit0；原实例未替换。回退必须relay/node/proxy一组回退，不将v2客户端指向旧线协议；保留所有任务/审计数据，不重放未知远端操作。

Prime独立ZIP提交e263f1b已push，tools-manager单ZIP调用替换，tar不变；extractzip移除、显式原锁yauzl/types，成员全预检/新空staging/exclusive写/小工具有界预算。实际六官方布局提取+hash、Win/Linux helper/consumer16pass、正常hooks通过。剩余风险报告继续有效，两项精确overrides仍独立提交，不能倒写成此ZIP阶段全安全通过。

## 正常工作衔接修复：固定入口、出站发布、原操作核对及文件权限

复核后继续修4项具体非硬件缝隙：access可配置固定localPort；publish正式出站SSH-R到受信入口loopback并等待真实转发确认；shared caller发前持有host/operation且成功/conflict/unknown均可核对、inspect复用目标ChangeClient分页；shared CAS保留Unix普通mode/Windows原生访问descriptor。没有增加任务DB、泛隧道框架或自动盲写重试。

Windows原rename确实改变protectedDACL，首观察保留；nativeReplace后ordinarySDDL D:→D:AI导致假unknown（内容已改）亦保留，最终仅规范0x400bookkeeping，其余owner/group/exactDACL/controlflags严格。首次ordinary/protected、native/compiled两路径均正常，消费者9pass/type0。caller早报type0错误明确撤回，Bunfetch属性修复后实际type0；临时publish负控与root全suite重叠215/2明确标concurrentfalsification状态，不当产品回归或最终绿，后续负控仅独立copy。后续sharedcore集成5fail与最终修复分别独立raw，不覆盖。

撤回时需对应还原hostprofile/固定端口引用与nativehelper部署，保留原operation引用、服务audit与文件实际hash；若变更后结果unknown，先inspect/readback而非重放。生产工作服务、原keys/admin/firewall在本阶段未改。拥有的验收入口按PID/profile释放，禁止全局killSSH。

## 正常 Node/Prime 冷启动的客户端边界修复

正常profile组合验收首跑Node控制器在导入.ps1时失败；换Bun控制器的诊断虽然起了真实NodeCLI/skills，但sharedtools没有加载，不冒称通过。根因是SharedFilesClient复用shared-files服务端模型和API envelope常量，间接引入只应服务端加载的Windows原生资产。

提取shared-files-model.ts（纯schema/hash/constants，无filesystem/Bun/nativehelper），client与operation类型仅依赖该模型；服务端保留兼容重导。真实Node+tsx客户端随后按同私有catalog发现并读两实际主机内容通过，Bun精确6pass/type0，完整正常PrimeCLI另以实际回执闭合。此为必要解耦，不新建框架或把Node依赖加到Env核心；回退必须同时恢复client/model/API引用，不能只删新模型文件。

## 最后验收归档

功能源码ba9a9d289eb1adb18799e18b2d597c7c1aa0d6c9已push/远端SHA核对，Windows221pass/type0；精确186文件Linux220pass1skip/type0，完整CLI编译+Node纯client图实际导入0，原锁hash不变。正常完整Prime88b7客户端七Env扩展/两skills冷启动及八turn两host浏览读取/inspect通过；0工作文件写/0paid。资源服务仍2801896，pure-model拆分后的API兼容性由新client实测，不将未热升级说成已部署最新文件。

`acceptance-report.md`统一最后验收范围，`normal-workflow.md`给产品正常入口操作。旧失败、首负控不足/并发临时源状态、纠正后实际exit与源码hash仍留在交接证据；没有删失败或强行升级真实权限来完成验收。运行/回退资料见私有配置引用与工作区12号清单，禁止把token/DB/keys/spool/session/编译产物提交Git。

此轮仅文档归档，不改变服务wire或数据schema。完整初始目标的真实六设备、逐指定身份管理员/实际配权和异地两站点仍未满足；后续按所有者提供的获准条件继续，不将该缺口改名为已完成或突然加联邦/HA框架作为首版门槛。
