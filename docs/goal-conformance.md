# 初始目标一致性与实际验收状态

截至本阶段，这是明确的使用结果与缺口清单，不是把原始目标缩成当前功能的“全部完成”证书。原始来源为用户三人六设备/Prime0.9.8协作目标与docs/design.md、docs/protocol.md，结合后续修改署名、不同用户自然协商、跨机CTF和异地接入要求。

| 原始/新增目标 | 实际结果 | 未闭合范围 |
|---|---|---|
| 多真实Prime实例协作 | 三个独立真实CLI/daemon/AgentSession/Agent、gpt-6.1-terra实际模型，Windows→Debian控制VM完成发现/消息处理环/经验/署名/真实SSH任务 | 不等于六台实际设备或完全无人自治 |
| 不同用户自然分工/CTF拿分 | 三真实Agent分别源-only限制、动态VM执行、结果复核需求，无固定leader；自主消息协商，Windows静态源与VMprobe/scorer分离，真实100分；三人均实际有用工作 | 当前自建隔离题；不能替代任意CTF或第三方授权 |
| 设备到管理主机登记 | VM真实POST202，pending记录可查询、独立DB readonly核对；统一Windows/Linux/macOS采集client与CLI | Windows native登记实际pending、VM Linux实际登记pending；mac未真机；自动公钥/admin配权未完成 |
| 各Agent自身SSH/admin | 严格主机密钥/现有身份真实登录，客户端session/route/TTL观察，sudo失败正确not-ready | 不同Agent尚未各有获准独立管理员身份；VMsudo-n仍失败 |
| NAT与异地入口 | 节点主动relay、编译proxy实际SSH；失败候选后回退到可用SSH路径；可配置跨平台access CLI/SSHcontrolforward已实际200 | 两个真实异地网络/独立故障域成熟入口还需用户可达基础设施，不能把同宿主NAT当公网证明 |
| 文件/工具/目录资源工作 | source-only共享读、实际VM动态程序/评分器、受控local/remote命令、输出结果和记录同步 | 完整动态资源图与长期job结果查询仍需进一步建设 |
| Unix持久会话 | 用户态tmux真实SSHPTY两次detach/reconnect同PID，清理自身session | mac真机/非预期断网/主机重启/所有客户端TTY体验未全覆盖 |
| 全Agent修改署名 | 注册、追加事件、offline队列、执行前后记录、Prime实际tool-call/result自动观察；实际CTF三Agent的intent/result均已同步 | 工具外/外部进程绕过不可自动捕获，观察记录不伪造每个文件修改因果 |
| 持久化与恢复 | SQLite/消息幂等/pull/ack/服务重启测试；spool保留/显式flush/同operation拒重放 | 产品化长期运行、完整DBbackup/恢复演练、运营容量仍需补 |
| 解耦/复用/可移植 | Env核心不依赖Prime；外部适配/CLI/client复用，用户态Bun，无新Env第三方依赖 | 编译产物/所有目标架构平台需逐项发布验证 |
| 阶段push/接手文档 | Env5b8deaf/1fe9e56/7aee3e8阶段，Prime61a643b；演进/回退与运维手册持续累计 | 7aee3e8已push；本阶段后续commit/push以实际回执更新 |

## 远程部署必须满足的真实条件

三位成员地理分离，必须有共同可达且加密的入口（现有受信SSH跳板、VPN/私网、或配置TLS的公网relay/API）。节点可主动出站，但不能无任何共同路径自动连通。不要明文公网暴露共享bearer/secret。产品提供可配置访问，不把主控临时IP/Secrets路径写进源码。

最终验收前继续对照这张表逐项核对；实际正常路径能用直接认可，不用过量防御检查否定成果，缺项也不伪称完成。用户授权、凭据和主机信任不能由其他Agent留言替代。
