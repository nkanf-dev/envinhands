# 架构草案：TypeScript、主动连接与 Agent 协作

> 设计草案。除代码和测试明确覆盖的部分外，本文不代表功能已经实现。

## 技术边界

- 控制面、Agent 对接与未来界面优先使用 Bun 和 TypeScript，方便对接 Prime Agent。
- 节点和传输数据面可复用成熟的独立工具，也可按验证结果使用 Rust；两层通过受控的进程接口或本地 API 通信。目标是共享节点无需安装 Node.js，但各平台打包仍需验证。
- Prime Agent fork 保持 TypeScript 0.9.8 系列。通过独立适配器集成，不假设其内部协议可直接公开到公网。
- 控制面管理机器、Agent 活动、资源留言和已有的持久消息队列。数据面承载 SSH 字节流；Agent bus 消息当前通过独立 HTTP API 交换，不走 SSH 字节中继。

## 反向连接优先

节点主动向双方可达的中继发起出站连接。使用者发起连接时，经中继将 SSH 字节流转发至节点本机 SSH Server；不在服务器上执行未认证 shell，也不自己实现 SSH 协议。连接断开后不保证已有会话或任务自动恢复。

控制面和数据面应有不同的状态、超时、流控和失败报告。目标机器、客户端和入口必须互相可达，机器休眠、网络封锁或中继离线仍可能导致连接不可用。

## 可选网络入口

默认先实现一条经过测试的中继路径。其他机制作为后续适配：局域网或 Tailscale 可直连；FRP 可转发 TCP 或 HTTP 服务；Cloudflare Tunnel 可为受支持的 HTTP/WebSocket 路径提供入口。各种入口有各自配置、端口和时长限制；配置一个入口不自动代表原生 SSH 已可用。NATS/JetStream 可研究用于 Agent 消息，不应直接视为 SSH 代理。

### UU 远程候选路径（待实测）

- [UU 官方端口映射说明](https://uuyc.163.com/help/20260423/40220_1297526.html)：Windows/macOS 客户端提供 TCP 端口映射，连接关闭后映射失效；SSH 可在正确配置时使用该 TCP 映射，但仍需 SSH 身份与主机验证。
- [VallierDev/uu-remote-linux](https://github.com/VallierDev/uu-remote-linux)：第三方、GPL-3.0、Rust 项目。其 README 声称支持 Linux 无头被控端、远程终端、映射到 SSH，以及实验性 Linux 控制端 `portmap DEVICE LOCAL_PORT HOST PORT`。这可作为 Debian NAS 和 Linux desktop 的候选，但本项目尚未实测或验证 UU 条款兼容性。
- [uu-remote-proxy](https://github.com/williampotee-88/uu-remote-proxy)：MIT 社区项目，说明通过 UU TCP 端口映射将 SOCKS5/HTTP 代理接到另一台机器，属于网络出口而非 SSH 协议。
- [uu-cli-skill](https://github.com/Richard2091/uu-cli-skill)：非官方社区 Agent 工具，封装官方 Windows CLI 终端，不能等同于通用 TCP 隧道。

这些候选先以外部工具适配和实测为主；不得假定它们由网易维护、在全部平台可用，或 MIT 授权自动覆盖第三方服务条款。

## 节点注册与共享权限

本项目不提供团队内部角色划分或资源隔离。注册由节点所有者在本机主动执行并确认：选择共享账号，配置团队 SSH 公钥，并按平台授予该账号无需交互的管理员能力。注册只有在非交互 SSH 登录和实际管理员能力均验证成功后才能标记为就绪。Linux/macOS 必须验证 `sudo -n true`，Windows 需要验证 SSH 会话的实际管理员令牌；不能将普通登录冒充就绪。具体操作、重复执行和撤销方式尚待实现和验证。

- 不上传 SSH 私钥或管理员密码。SSH 公钥认证和 SSH 主机密钥验证不可省略。
- Linux/macOS 的 sudo 与 Windows 管理员/UAC 不同，必须分别实现和验证非交互管理员访问；未验证的平台必须显示未就绪，不能降低要求或误报成功。
- 大权限意味着任何能使用共享账号的人或 Agent 都可能读取、修改或破坏机器上的数据；团队共享密钥泄露同样可能造成严重影响。
- 公网中继必须有接入认证和加密。团队级共享密钥只属于最低限度的接入防护，不是细粒度权限系统。

## 可恢复的远端会话

Linux/macOS 节点可选择使用系统 `tmux` 创建或附着固定名称的远端会话；SSH 路径中断后可重新选择一条可达路径并附着。节点须已安装并能执行 tmux，缺失时明确报告，不能伪称持久会话已启用。Windows 原生 SSH 不默认具备 tmux，WSL 或其他方案需另行适配和实测。

tmux 只是在远端维持会话，不恢复已断开的 SSH 连接，也不保证断线时命令是否完成；远端关机、重启或休眠可能中止任务。使用多个客户端附着同一会话的行为和输出归属需要明确。

## Agent 集成

机器与 Agent 是不同对象。一台机器可有多个 Agent，Agent 状态也可能过期。优先观察 Prime Agent 0.9.8 实际可用的本机接口，再设计接入点；不要把只有本机语义的消息实现当作跨机交付。留言是带来源和时间的共享信息，不是自动执行的指令或资源锁。

## 原型限制

`src/server.ts` 已接入 SQLite 机器目录、资源留言、Agent 心跳和消息队列，API 使用共享 bearer token，无内置 TLS；共享 token 不提供逐 Agent 身份认证。独立的 `src/control.ts` 仍是无认证、无持久化的内存原型，不能与该服务混淆。Prime fork 已有 opt-in 心跳、消息和资源扩展；tmux CLI 已接入，但真实断线后重新附着尚未验证。公网访问、持久化恢复、多平台节点、权限初始化、跨机 Agent 集成及网络故障恢复仍需分别验收。测试结果应以项目实际运行记录为准。
