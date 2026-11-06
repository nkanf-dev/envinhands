# 三人团队多传输与低带宽实施计划

> 设计与调研，不是部署说明、可用性承诺或授权。只确认了用户提供的事实：真实 Debian x64 NAS 当前仅通过已有 FRP 暴露 SSH 端口；具体拓扑、frp 版本、出口、带宽、密钥和三位成员网络均未知。不得扫描、登录或修改真实 NAS。本计划优先保护现有测试路径；新入口均先在隔离 fixture 验证，再由所有者逐项批准。本文所有版本、价格、条款、平台组合在实际采用前重新核验。

## 1. 最小可用与目标边界

- **今天**：把现有 FRP SSH 地址视为用户提供、已配置但本计划**未实测**的保底入口；不安装任何新后端，不改现有 frpc/frps、路由器或防火墙。先让用户按现有方式继续测试。严格 SSH 主机公钥经带外核验，逐人使用授权身份。FRP 地址不等于 NAS 公网地址。
- **最小增量**：在本机登记既有入口及同一可信 `HostKeyAlias`，先通过现有严格 SSH 连接；只有所有者已经允许远端 TCP 转发且需要本地服务时，才使用现有 `access`。转发不可用不意味着 SSH 本身不可用，不为便利修改 sshd。无权限转发时既有交互 SSH 仍可用。
- 控制面和数据面分开：SSH 字节流、控制 HTTP、同步/大文件各有各自路由与健康证据。当前 HTTP 服务共享 bearer、无内建 TLS；必须通过可信受控 SSH/合适的 HTTPS 私有入口，不能因有隧道就公开服务。某路径可 SSH 不代表控制 API 正常；反之亦然。
- 接下来分批引入可选的直连覆盖网、独立入口和 relay。无需三人同时迁移；每人独立 opt-in，保留 FRP，任何失败只影响新增候选。主机密钥变化或用户认证失败绝不通过绕过验证“修复”。
- **带宽事实**：不同地点要读取 NAS 上独有的 N 字节，至少需 NAS 发出约 N 字节，加密/协议有额外开销；中继、P2P 或 Cloudflare 不能凭空消除它。P2P 主要节省中继/VPS 流量和绕路成本，并不自动减少 NAS→客户端流量；从 NAS 上传到远端亦同理。每个流量方向、每个服务器分别计量。

## 2. 现有代码与证据（不是产品承诺）

| 项目 | 已有实现 | 限制 / 接下来 |
|---|---|---|
| 策略 `src/transports/policy.ts` | 根据调用者提供的健康时间戳、配置标志与优先级选 fresh healthy；过期/未知不选，允许排除已失败 ID | 纯策略，不探测、不建链、不迁移；没有依赖域、成本、并发竞速或健康持久化 |
| `src/transports/ssh-routes.ts` | 按优先级在总预算内串行运行严格 SSH `true`，以同一 host key alias 验证并返回首个成功 route；host/port、jump、实验 relay | `SshRoute` 无 frp/CF/VPN 类型，FRP 和组网地址只是普通 host:port；不是自动发现。只记录 exit code/状态，不区分错误；构造器当前**对 Windows 无条件 fail closed**，所以复用它的路径不能宣称现行 Windows 通用；与旧 `docs/remote-access.md` 的跨平台表述冲突，以当前源码和该版本实测为准 |
| `src/remote-execution.ts` | 执行前选路与持久审计；命令一旦启动不自动换路重跑；255/null 标记 unknown | 健康探测与真正执行之间仍有 TOCTOU；用户命令失败或启动后断线不能当作可安全重试 |
| `src/remote-access.ts` / `src/remote-publish.ts` | access 本地 loopback listener，通过受信 SSH `-W` 到远端 loopback；publish 经授权 SSH `-R` 发布到入口机 loopback，等待 OpenSSH 确认 | listener 就绪不等于远端/API 就绪；需要现成 SSH 路径和转发许可，复用上面 Windows 构造器限制；不建立 NAT 穿透。publish 的 URL 在入口机本地；文档记载 Windows↔Debian VM 历史测试，不能外推当前源码、真实 NAS/异地 |
| `src/ssh-stdio-access.ts` | Unix `/usr/bin/ssh` + 远端 `/usr/bin/python3`，通过 SSH stdio 连接远端 loopback | 与 `-W` 权限/依赖不同，仍须远端可执行 Python、允许该命令；不是绕过安全策略的方法；仅在所有者批准后评估 |
| `src/transports/uu.ts` / `rathole.ts` | 仅启动外置进程并跟踪退出；UU 示例调用第三方 `uuremote-viewer portmap` | spawn 不是映射健康；UU 不控制本地监听地址，必须审计，不可假设官方客户端有该 CLI。rathole 不校验配置、认证、加密 |
| `src/relay.ts`、`node-runtime.ts`、`ssh-proxy.ts` | WebSocket relay v2、节点重连、方向 FIN/ACK 和限量缓冲；可承载端到端 SSH | 明确测试原型，共享 secret 无逐节点/用户授权与完善防滥用，不可公网生产部署；现有 Windows proxy builder 有上述禁用。FIN ACK 不代表业务处理完成 |
| 测试与现场 | `test/policy.test.ts`、`ssh-routes.test.ts`、`remote-access.test.ts`、`uu.test.ts`、`rathole.test.ts`、`relay.test.ts` 等已有 fixture；`docs/acceptance-report.md` 记载历史 Windows↔VM 真实验证 | `test/nas-process-e2e.test.ts` 是本地临时服务/进程，不是真 NAS。历史版本结果≠本次运行，更不是三地点、NAS 或后端验收。本文没有运行这些测试，也没有连接 NAS |

## 3. 候选对照：能力不是集成或实测

标记：**代码局部**=仓库已有相关模块，不代表真实服务可用；**候选**=仅设计；**外部现状**=用户描述；**未实测**=本计划没有对目标组合验收。所有 OS/架构仅是待核对的上游构建目标，不能据项目首页推断每个组合及功能。

| 后端及用途 | 仓库状态 / 网络形态 | 配置、授权与运行依赖 | 平台与成本/许可、风险 |
|---|---|---|---|
| 既有 FRP TCP→SSH | 外部现状；普通 SSH host:port 已可表达；真实链路未实测。frpc 从 NAS 连接 frps，客户端连 frps 暴露的端口，SSH 为端到端 | 已有 frps、公网入口、NAS frpc/服务端配置、SSH 身份和 host key；版本、TLS、token/鉴权、bind ACL 与实际配置需核验。若 frps 不归团队所有，先确认使用权和计费 | FRP Apache-2.0；上游有 Linux/Windows/macOS 多架构发布，逐个核查 Darwin arm64、Linux amd64、Windows 体系。中继双端流量穿过 frps；frps 宕机共享失效 |
| FRP XTCP 打洞 / STCP | 候选，需两端额外组件和现有/另设 frps 协调；XTCP 成功时数据直连，STCP 仍经 frps relay | XTCP visitor、密钥、协调与 UDP/NAT 环境、上游版本限制；支持显式配置 STCP visitor fallback，并非无需配置自动可用。原 TCP 入口不能据此当作已配置 XTCP/STCP | 同 FRP。打洞成功才可能节省 frps 数据流量；不同模式仍可能共享 frps 协调/账号；不改单点原配置先 fixture 验证 |
| Tailscale | 候选；受控节点加入同一 tailnet，走私网 IP 上普通 SSH；尝试直连，失败使用 DERP 中继（可能后续切直连） | 每端客户端/服务、登录、设备授权、ACL/grants、UDP 与本机权限；服务自身控制面及 DERP 仍是依赖；使用 `tailscale status` / `tailscale ping` 作为观察，不能把登录当成直连 | 客户端 BSD-3-Clause；托管控制服务另有计划/使用条款，三人可能符合免费额度但必须以实时定价/用户数/设备和功能规则为准。mac ARM、Linux amd64、Windows 客户端各自核对；Linux TUN/权限、macOS app 权限、Windows 驱动/服务须用户批准 |
| Headscale + Tailscale 客户端 | 候选；自建控制面替代托管控制；数据仍是客户端之间直连或经 DERP | 需可用的 Headscale、域名/TLS、预授权密钥、备份升级、兼容版本及独立 DERP 可达性；Headscale 本身不自动成为数据 relay。不要把自建控制面等同于摆脱所有外部依赖 | Headscale BSD-3-Clause；自行承担计算、网络及运维费用；与 mac ARM、Linux amd64、Windows 客户端兼容性依版本实测。可选自建 DERP，其与控制面同机时仍共故障域 |
| EasyTier | 候选；每端外部服务构造虚拟网，经虚拟地址 SSH；可直连、必要时由节点转发 | 网络名/密钥、对等节点或自有入口、节点发现、地址规划、系统 TUN 和防火墙权限；公共节点仅 opt-in，不视为 SLA/免费带宽；明确哪些节点允许转发、记账与隐私 | LGPL-3.0；上游发布目标含 Windows/macOS/Linux 和多架构，但四个指定组合与版本逐一验证。P2P 不保证建立，节点 relay 可能将成本转嫁到第三位成员 |
| Cloudflare Tunnel + Access SSH | 候选；NAS 出站 `cloudflared`→Cloudflare→客户端 `cloudflared access ssh` 的 SSH ProxyCommand；实际身份、SSH host key 各自验证 | 必须允许在 NAS 或同局域网获准机器运行 connector、出站访问 Cloudflare、配置账号/域名/DNS/Tunnel、Access 应用及身份策略；connector 出站 TCP 或 UDP 7844 需可达（上游推荐两者），客户端也需 cloudflared 与可完成 Access 登录/服务身份。不能在现有 FRP SSH 上凭空生成该路径；长连接行为和断网重登要实测 | cloudflared Apache-2.0；Cloudflare 服务按账户/套餐/产品条款和可能限额计费。Linux amd64、Darwin arm64、Windows 平台及 OpenSSH ProxyCommand 与登录体验须逐一验证。Cloudflare/账号/身份提供商均为共同依赖，不能当独立双路径 |
| Cloudflare 私网/WARP | 更远期候选，与上行 SSH Access ProxyCommand 是不同产品路径 | 需 WARP 客户端、私网路由、Zero Trust 设备注册和策略、connector 与许可；不同版本的可用性/路由冲突要实测 | 套餐与条款另核；私网通了不自动授权任意服务。不能把任意原始 TCP 直接绑定普通免费 CDN 记录当作 Tunnel 能力 |
| UU 远程官方端口映射 | 候选，官方桌面客户端手动映射 TCP；生命周期与连接状态相关，实际能否适配 NAS 须核实 | 官方账号/设备配对、被控端与控制端、用户明确同意；官方文档的 GUI 操作不等于可脚本化 API、无头 Linux 或自建 relay。NAS 仅 SSH 不能假定能装或登录 UU | 软件/服务许可、时长、跨区计费和第三方使用条款待查；Windows/macOS官方 GUI 的实际 CPU 兼容性、Linux 被控/控制、映射监听与安全均待证。任何 P2P/relay 状态须观测，不能假设 |
| `uu-remote-linux` 社区实现 | 代码局部：仓库仅有外部 `uuremote-viewer` 的启动 wrapper；实验候选、真实未测 | 非官方、项目称无头及 portmap；需确认版本语法、账号授权、与官方协议/条款兼容性、本地监听安全及独立二进制来源；不保存密码到日志/argv | GPL-3.0；先评估分发、组合与合规义务，单独进程亦须法律审查。CachyOS/NAS x64 可行性和 Mac/Windows viewer 均未证明；服务端协议变化可能破坏 |
| rathole / wstunnel | rathole 仅进程 wrapper；wstunnel 候选；都是用户自建公网入口的独立反代方案 | 安装两端、配置认证、TLS/Noise 等版本可用的加密模式、安全权限、服务器与端口；不能依赖 spawn 当健康 | rathole Apache-2.0；wstunnel BSD-3-Clause；服务端及带宽有费用。若与 FRP 同 VPS/网络/域名，则不是独立容灾 |
| EnvInHands 自有 relay | 代码局部且有实验测试；纯候选，不可公开部署 | 需完成独立身份、鉴权、TLS、流控、限额、滥用处理、运维等安全门槛；出口服务和节点必须可达 | 代码是本仓库原型，不推断其开源许可证；服务器出入流量均计费，失效同域。优先使用成熟外部组件而非抢时间自行造轮子 |
| iroh / js-libp2p / RustDesk | 研究候选，非即插即用 SSH 路由 | iroh/libp2p 需另做身份、发现、NAT、TCP 桥接、relay 与兼容测试；RustDesk 的远程桌面/端口映射与 SDK/脚本能力分别核验 | iroh MIT OR Apache-2.0；js-libp2p 逐包查许可及 Bun 兼容；RustDesk AGPL-3.0，服务费用/授权另核。均非现阶段阻断测试的依赖 |

### 指定平台验收表

| 端 | 基线与候选 | 不可假设的前提 |
|---|---|---|
| Mac Apple Silicon ARM64 | 系统 OpenSSH + FRP 暴露的 SSH；另测对应 arm64 Tailscale/EasyTier/cloudflared 包 | macOS 版本、签名/公证、系统扩展/TUN、权限、休眠唤醒；当前仓库未做真机验收 |
| CachyOS x64 | OpenSSH + FRP 端点；另测上游 Linux amd64 包 | 发行版是滚动版，glibc/内核、NetworkManager、防火墙/TUN、systemd 和包来源/哈希各自确认 |
| Debian NAS x64 | 现有 frpc/sshd 不触碰；后期按所有者批准运行可选 connector 或 VPN | sshd 的 TCP 转发策略、出站 UDP/TCP、防火墙、磁盘/CPU/开机服务、Docker 与否和 NAS 休眠均未知 |
| Windows | 用用户现有 OpenSSH 继续直接 SSH；其他后端及本仓库新 route builder 均单独实测 | 当前 `ssh-routes.ts` 禁止 Windows；不以历史代理/旧文档覆盖此事实。需评估 Windows OpenSSH 参数、ProxyCommand、路径转义、服务/驱动和 ACL，不能降级安全检查 |

## 4. 数据路径、依赖和优先级

例子中的 `→` 是实际数据流；协调或认证依赖另列。路径必须由操作者明确配置，**无资格探测则显示未配置，不进行公网扫描**。优先级只约束新连接；用户可强制使用一个路径。

1. 用户已验证可信同 LAN 或直连地址 → NAS sshd：最少中介；仅明确配置才尝试，跨网段不扫描、不猜公网 IP。
2. 已配置 VPN 的**实际直连**（Tailscale/Headscale 或 EasyTier）→ NAS sshd：减少 VPS relay 带宽。控制面/打洞服务并非数据流，但在建链或节点状态更新时仍重要。必须以各自可观测状态佐证 direct；未知不声称 direct。若 VPN 内部自动改走 relay，把该次实际路径标为 relay，允许其优于 FRP 与否由明确成本策略决定，不能保证应用能控制 VPN 内部切换。
3. **已有 FRP TCP** → frps → NAS frpc → sshd：默认保底，优先于从未配置的新方案。frps 是数据/入口共同故障域。XTCP 成功时可升级为直连候选，否则保留独立 TCP mapping；须先配置并验证，不改变现有服务。
4. 经明确授权、独立部署的 Cloudflare Access SSH，或其他 frps/rathole/UU：各自证实端到端 SSH 后才候选。以可用、时延、费用、共同依赖和组织许可调整顺序；CF 可能受 DNS、账号、IdP 或 cloudflared 共同影响；UU 可能依赖第三方账号和其 relay。候选未配置不等待登录或拉起 GUI。
5. 经批准的 VPN DERP/EasyTier 节点转发、自建成熟 relay：只有在具备配额、可用和许可时才选。自有 EnvInHands relay 保持测试网络实验，不是公网保底。自建 DERP 不自动免付 VPS/出口费。

严格说如果某 VPN 已经内部自动落到 relay，同一个 `host:port` 的应用外层无法总是预先知晓；应标示 `direct|relayed|unknown` 和观测时间，在有可信数据时排序，无法控制时只将其当可到达的 VPN 候选，不做虚假带宽承诺。避免依赖 FRP 才能配置/发现所有备用路径：将**不含密钥**的候选元数据及可信主机公钥别名离线分发到每个客户端；私钥和登录状态留各设备本地。DNS、证书/IdP、同 VPS、同 ASN/运营商、同电源、同 NAS 上行和共同 sshd 是共同故障域：即使两个 tunnel 产品不同也不代表独立。NAS 本机/上行或 sshd 故障时所有到 NAS 的路由均无法提供服务。

### NAT 穿透、隐私与接口边界

P2P 需要先通过协调/信令交换候选地址，再做连通性检查；STUN 可帮助发现 NAT 映射，不能转发业务数据；TURN 类服务负责 relay，但不会消除中继带宽/成本。端点依赖型 NAT、对称 NAT、运营商 CGNAT、阻断 UDP 或企业防火墙均可能使打洞失败，不宜声称 100% 直连。[ICE RFC 8445](https://www.rfc-editor.org/rfc/rfc8445)、[TURN RFC 8656](https://www.rfc-editor.org/rfc/rfc8656) 是基础原理，不意味着上述每个产品均以 ICE/TURN 实现。直连可能向对端暴露公网 IP；受威胁模型要求时可选择具备该能力且已验证的 relay-only 策略，仍保留 SSH 端到端加密和身份验证。

控制接口是**可选集成边界**，不是登录凭据托管的借口：Tailscale 状态和 ping 用安装版本的 CLI，OAuth API 能创建授权密钥但需另行授予和限定权限；Headscale 有受认证保护的 REST `/api/v1`、部署版 `/api/v1/docs` 与 CLI，预授权密钥具有效期与使用次数，自动注册要经管理员批准。EasyTier 有可自托管 Web 控制台、Web API 和配置分发，需核对版本和认证，不假定其 API 稳定或默认开放。Cloudflare 使用用户自建 Tunnel/Access 配置，不暗示该项目已有账号或 API 集成。UU 官方 GUI 映射不能据此虚构管理 API；未发现不等于绝对不存在。上述 API 密钥只留受限本机，最小权限、到期撤销，不进入共享 bearer 服务。

### 两个实用部署拓扑（均待批准）

- **A：不改 NAS 保测试**：三成员 → 既有 FRP SSH → NAS；访问本机服务需要 sshd 明确允许 `-W` 转发；每个客户端维护已核验主机公钥。没有新架构依赖，亦无独立故障恢复。
- **B：逐人增配一个独立路径**：保留 A；经批准后 NAS 与每个客户端加入私有 VPN，并为该 VPN 配可信控制面与可选 relay；尝试直连，失败按实际配置落 relay 或用 A。另可在**与 FRP 不同基础设施**建立 CF Access SSH 出站 connector（或独立 VPS）；这些候选要分别测试，不能假设一定独立。覆盖网不替代 SSH 用户鉴权，CF Access 也不替代 SSH host key 验证。

## 5. 未来适配器契约与安全选路

以下为**待编码契约**，不暗示现有 CLI 已实现：

- `Candidate`: 稳定 id、类型/来源、enabled/配置版本、endpoint 引用、身份引用、hostKeyAlias、owner/批准、成本类别、共故障域标签、可能的传输类别、观测时间；只保存引用，不从发现服务接受 SSH host key 或执行命令。启动参数、密钥、Token 和设备码不进共享目录/日志。
- `discoverLocal()` 只读取受信配置和可选本地工具状态，必须受范围/超时限制；不安装、不自动登录、不开端口、不改系统路由。`prepare()` 为显式批准的、归本进程所有的必要子进程/loopback 资源建立句柄；外部用户守护进程只读不接管。`probe()`、`connect()`、`close()` 分离，超时可取消，close 幂等且只清理本次拥有的资源。VPN 本身的特权安装/升级与运行是单独获批步骤。
- 分层结果：`disabled` / `unconfigured` / `needs-approval` / `needs-login` / `unknown` / `probing` / `transport-reachable` / `ssh-verified` / `service-verified` / `failed` / `stale`；每条含时间、版本、总耗时、错误类别、TTL 与来源。进程启动、TCP accept、Tunnel connected、局域 IP、SSH 认证和 HTTP 200 不能互相等同。服务认证探测使用最小只读 API，不泄漏 bearer 到候选提供商。
- 同一目标跨路径使用预先**带外**核对的 `HostKeyAlias`、专用 `known_hosts` 和显式身份；只用严格检查。连接目标地址来自可信配置，不信任远端建议重写目标。FFI/子进程用受限 argv 而非用户 shell；必要 ProxyCommand 的固定模板、二进制路径及平台专属转义必须审计，stdout 仅字节流、错误信息脱敏。环境隔离，禁止 agent forwarding、意外的 OpenSSH 全局配置或身份扩散。
- 分层失败：本地缺程序/配置/登录/权限直报并跳过；超时、TCP 断开、入口拒绝可在总预算内尝试下一已批准路径。**host key 不匹配是安全事件，默认停止该目标的自动选路并要求人工处理**；不能因为下一条路径成功而静默掩盖。认证失败默认停止对相同身份/目标的跨路重试，避免锁号；仅操作者明确允许且不同身份的候选另判。DNS、权限、身份、主机密钥与网络错误应分类，不从不可靠的 stderr 任意猜测；不可判断就显示 unknown。目前代码只有统一失败，需改进而非冒称已支持。
- 新连接按用户偏好 + 健康 + 成本 + 依赖域排序；可设一个短总预算和每条上限，使用单调时钟及 TTL，指数退避+抖动、并发上限；后台低频探测且不重复登录、不主动下载大文件。不在首次使用前全量探测所有后端。目标初值（待实际量测）总预算 8s、单条 2s、仅两条并行且错峰 200ms；需兼容慢 Access 人工登录，因此登录路径不在自动探测预算内，交互由用户主动触发。最后结果要包含每条为什么未试/失败和预算耗尽。
- 分级竞速仅在无副作用认证探测阶段；最先通过严格身份校验者胜出，取消并关闭其余探测、监听和子进程；不可并行执行真实任务。若资源清理不成功，显示错误而不是假装已清理。已有 `selectSshRoute` 是串行，改变它需新增测试与功能开关。
- 实际连接与探测存在 TOCTOU。**在任何命令/写操作发送前**连接失败才可试下一路；一旦可能已执行或状态不明，停止自动重试，返回 `unknown`、operation ID 与原目标，先 inspect/读回比对；不重新发写。成功建立的 SSH 断线即断线，不透明迁移 TCP 字节流、不重复发送 HTTP 请求。Unix 经用户显式管理的 tmux 重连可能恢复进程，但不保证机器断电或远程命令完成，Windows 另作设计。

## 6. 降低 NAS 上下行与成本

1. 先测基线：每客户端到 NAS 的方向字节、SSH 加密/重传开销、每 relay 入/出、时间、p50/p95 时延及多用户并发；三人各自网络、NAT 类型、流量限额、成本和高峰时段分开记录。VPN 上报的 direct/relay 类型须带时间戳，未知就标未知。只记录聚合数值，不采集文件内容、用户名或 IP 明文。
2. 减少重复读：在可信客户端本地缓存**只读**内容（hash/version/TTL、权限与上限），多人对同一不可变对象可经单独授权的可信缓存/镜像分发，首次由 NAS 发送一次，其余从缓存读取，代价转移到缓存节点。必须验证内容 hash、访问权限、加密、撤权后的删除及过期；服务端真实授权/版本变更不可被本地 TTL 替代。跨用户共享缓存有隐私风险，默认关闭；不得绕过现有 `sharedRoots`。
3. 变更只传差异：分页/条件请求、变更摘要、压缩可压缩文本、合并/限频心跳、下载校验/可恢复分片；对已压缩内容或高 CPU NAS 禁用无收益压缩。当前 `shared-files` 的受限单文件和 CAS 语义不等同 rsync/大文件服务；以上是待设计而非已具备。
4. 优先远程计算/过滤、按需读；慎用 `ssh -C`：仅显式开启，对压缩数据/带宽充裕或 CPU 紧张可能更慢。三人看同一大文件时直接各自下载会产生约三份 NAS 上行；可信共享缓存能减 NAS 流量但会占别的节点出站和存储。
5. 对 relay 设置流量/预算告警、限速、并发与关闭条件；**费用上限不应伪装成网络故障**。探针只发送小型无副作用消息，不做周期性吞吐压测。业务控制请求与大文件采用分离的配额/连接，避免饿死交互 SSH。实际优化基于测量，不承诺某项会降低总流量。

## 7. 分阶段编码与可自动化验收

每个阶段均保留可关闭开关及原 FRP 路径，优先本地 fixture；用户正在测试时不等待 VPN/账户/公网资源。只在独立隔离环境创建自有进程和随机端口；测试绝不隐式连接真实 NAS、安装 TUN/驱动、登录账号或更改系统防火墙。命令为计划，不表示已执行。

**P0 当前测试基线（立即；零部署）**
- 与所有者离线确认现有 FRP endpoint、SSH 用户、已有权限、host key 指纹和本机私钥引用；在已获准的测试窗口做一次只读 SSH，不更改 frp/sshd。确认三个成员已有各自授权，不能复用共享私钥。现有入口当前不视为独立可靠。
- 在无 NAS 的环境运行 `bun test test/policy.test.ts test/ssh-routes.test.ts test/remote-access.test.ts test/remote-execution.test.ts`、`bun run typecheck`；标注实际环境、提交/工作区、pass/skip/fail，不用 fixture 结果代替现场。
- 手动记录当前 Windows 限制，避免为跨平台而禁用验证。现有 SSH 客户端能工作时用户继续用它；产物缺项不阻断测试。

**P1 路由描述/选择与安全（首批可编码）**
- 扩展 `src/transports/policy.ts`、`src/transports/ssh-routes.ts`，增加依赖域/成本/分类状态和证据时间；兼容旧格式及旧优先级，先通过 feature flag 关闭新调度。保留原直接 host:port，不能要求先装第三方。
- 测试：fake clock/runner 检验 stale、负时间、重复 ID、预算严格上限、失败域并非强制排除同域可用路线、认证与 host key fail-closed、所有失败结果、取消与清理；`true` 成功而执行前断链、命令已发后断链必须返回 unknown 且执行次数≤1；分别验证用户强制路径和禁用状态。模拟探针恶意 stderr/秘密确保脱敏。
- 单独修复 Windows 构造器：明确 Windows `ssh` 环境隔离方案、可信 known_hosts 和身份、路径/引号/特殊字符、ProxyCommand 安全性；先测试 Windows 原生 OpenSSH，再启用具体功能。不因 `NUL` 不确定就退回全局配置或 `accept-new`。Linux/macOS 上隔离回归，确保 host key mismatch 不降级。

**P2 后端只读诊断 + 已配置 VPN（不自动安装）**
- 新增可测试的 adapter 接口、配置/schema 和 `diagnose`（名称待定）；优先对已安装已登录 Tailscale 或 EasyTier 读取本地受信状态与已配置地址，验证所用版本的 JSON schema，不把供应商输出当命令执行。识别 direct/relay/unknown；组网和系统权限由用户手工配置。SSH 实际探测和服务验证与状态检查分层。
- fixture runner 模拟缺命令、无 socket、未登录、过期密钥、离线、direct→relay、状态字段变化与恶意输出；Windows/macOS/Linux 预设输出与权限错误；完成后无多余子进程/端口。若官方 CLI 状态没有稳定 schema，固定版本解析并标记未知，而非猜测。
- 可选隔离端到端：两自有容器/VM+受控 DERP/对等节点，通过网络隔离模拟 UDP 阻断、控制面关闭、relay 不通、不同 NAT、休眠/恢复、分区回联；SSH fixture 有确定 host key。不能从 mock 推断跨互联网 NAT 通过率。

**P3 保底候选：FRP 扩展 / Cloudflare / UU**
- FRP：既有端口不需专有 adapter；若研究 XTCP，针对隔离 frps/frpc/visitor 固定版本、预设配置、最小权限，增加独立 lifecycle 和状态；原 TCP 作为明确 fallback。测试 visitor 挂掉、协调/数据分别阻断、抢端口、未配置/密钥错误、两条同 frps 故障与清理；不触碰真实部署。
- Cloudflare：先做由用户自己管理的 connector 和 Access，客户端适配固定的 `cloudflared access ssh` 入口；ProxyCommand 参数只从可信配置构造，验证交互登录与无交互机器身份的授权/失效；测试 IdP 登出、token 过期、connector/Cloudflare/DNS 拒绝、stdout 纯字节、SSH 指纹不一致、进程取消及资源回收。不能把 HTTP WebSocket 能力混同任意 TCP；任何线上测试须用户拥有账户和授权。
- UU：先核对官方/社区版本和条款，手工 GUI 或用户已配置社区 viewer，验证监听地址为 loopback 再建立 SSH；不证明就**禁用自动启动**。mock `uuremote-viewer` 的 argv/错误、端口抢占、本地绑定泄漏、连接退出、撤销/关闭并清理；三大桌面 OS 各独立真实验收。保留 `src/transports/uu.ts` 的进程启动≠就绪语义。

**P4 自建 relay、数据节流与生产加固（最后）**
- 对 `src/relay.ts` 的公网化先设计 per-node/client 强身份、细粒度授权与撤销、TLS、日志隐私、限速/总流量及资源上限、慢客户端反压、版本升级、协议兼容与安全评审；成熟外部服务可先试用。不达标继续仅限可信 fixture。
- 多连接和半关闭、FIN/ACK、背压、死连接、限流、失败中途断线、损坏与崩溃重启、泄露凭据和非授权节点模拟；记录每方向字节，确认数据不重复/不丢失时才报告成功。重跑现有 `test/relay.test.ts test/ssh-proxy.test.ts test/node-runtime.test.ts`。缓存需单独做多用户授权、篡改、撤权与过期、写入 CAS 冲突、损坏恢复测试。

### 真机验收门槛（必须单独获批）

每个成员、每种实际 OS/CPU、至少两个真正异地网络分别记录版本、具体测试时间、入口和其故障域、上行/下行、host key 带外确认方式、认证结果、direct/relay 证据、延迟和是否出现自动回退。先只读再尝试获批的写；禁用其中一个入口证明新连接可回退，恢复后证明原入口不被破坏；对 NAS 的操作由所有者监督并有回滚计划。测试结束检查仅清理自己创建的进程/端口，不导出私钥、token、设备地址或用户数据。对权限/条款尚未确认的项标记 blocked，不归入通过。

## 8. 官方资料与条款核验

以下链接用于核对原始资料；仓库功能以实际使用的版本为准。开源代码许可证不等于云服务可免费/无限使用，也不保证法律兼容。自建 VPS、域名、流量、运维均有成本。调研未证实的功能明确保持候选。

- FRP [官方仓库与文档](https://github.com/fatedier/frp)、[XTCP 与 STCP fallback](https://gofrp.org/en/docs/features/xtcp/)、[STCP/SUDP](https://gofrp.org/en/docs/features/stcp-sudp/)、[visitor 配置](https://gofrp.org/en/docs/reference/visitor/)。核验所用版本的 xtcp visitor、加密、带宽和认证配置。
- Tailscale [连接类型及 DERP](https://tailscale.com/kb/1257/connection-types)、[设备密钥](https://tailscale.com/docs/features/access-control/auth-keys)、[定价](https://tailscale.com/pricing)、[客户端源码/许可](https://github.com/tailscale/tailscale)。功能和定价随服务变化。
- Headscale [仓库/许可](https://github.com/juanfont/headscale)、[节点注册](https://headscale.net/stable/ref/registration/)、[API](https://headscale.net/stable/ref/api/)、[DERP](https://headscale.net/stable/ref/derp/)。各客户端版本的兼容矩阵和实际自建方式应使用对应发布文档。
- EasyTier [源码/许可证](https://github.com/EasyTier/EasyTier)、[下载与平台](https://easytier.cn/en/guide/download.html)、[Web 控制台](https://easytier.cn/en/guide/network/web-console.html)。公网节点可用性和谁承担转发成本需要单独确认。
- Cloudflare [SSH through Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/)、[隧道协议与客户端](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)、[防火墙要求](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)、[cloudflared 源码](https://github.com/cloudflare/cloudflared)、[Zero Trust 定价](https://www.cloudflare.com/plans/zero-trust-services/)、[服务特定条款](https://www.cloudflare.com/service-specific-terms-application-services/)。CF 各种 Tunnel、Access、WARP、Spectrum 不可混用承诺。**使用前核查当前自助免费/付费服务、商业使用、非 HTML 内容交付、缓存及持续传输等适用条款**；其 CDN 服务条款对 Free/Pro/Business 通过 CDN 交付视频或其他大文件列明付费服务要求及限制权，这不等于对 Tunnel SSH 的一概禁令；不要把旧版“禁止全部非 HTML 流量”简化为当前 Tunnel SSH 普遍禁令，也不要从 SSH 文档推断无限带宽、可用性或自动允许大文件分发。遇到条款不明确先询问 Cloudflare 或选择自行付费 relay，不将其设为唯一保底。
- UU 官方 [客户端下载与系统要求](https://uuyc.163.com/download)、[被控设备支持](https://uuyc.163.com/features/support)、[端口映射说明](https://uuyc.163.com/help/20260423/40220_1297526.html)；非官方 [uu-remote-linux](https://github.com/VallierDev/uu-remote-linux)、[uu-remote-proxy](https://github.com/williampotee-88/uu-remote-proxy)。官方 GUI 文档不是第三方实现的授权书；社区项目 README 是其自述而非实测或服务方许可。
- [rathole](https://github.com/rapiz1/rathole)、[wstunnel](https://github.com/erebe/wstunnel)、[RustDesk](https://github.com/rustdesk/rustdesk)、[iroh](https://github.com/n0-computer/iroh)、[js-libp2p](https://github.com/libp2p/js-libp2p)。

**开放问题**：三人各平台、网络及实际需求；是否允许 NAS 额外进程/TUN/出站 UDP；FRP 由谁维护、是否已经拥有独立备用 VPS；CF 域名/账号与 IdP 是否由团队控制；预算及允许的 relay/第三方；能否部署本地可信缓存；每条新增路由与失效演练的所有者授权。这些不阻断继续使用已有 FRP SSH。
