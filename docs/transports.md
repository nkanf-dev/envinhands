# 连接后端候选清单

> 这是调研清单，不是已实现功能或稳定性保证。许可证以对应仓库当前条款为准；兼容性与安全需要单独审查。

| 候选 | 用途 | 集成方向与限制 |
|---|---|---|
| EnvInHands 中继 | SSH 字节流；节点出站连接 | Bun 原型开发中；未通过公网和故障测试，不应生产使用 |
| [UU 远程官方端口映射](https://uuyc.163.com/help/20260423/40220_1297526.html) | 映射 TCP，可在正确配置后承载 SSH | 使用官方客户端；Windows/macOS，连接关闭时映射失效；自动化需确认 |
| [uu-remote-linux](https://github.com/VallierDev/uu-remote-linux) | 非官方 UU Linux 被控端，实验性控制端 portmap | GPL-3.0；文档称支持无头和 SSH 端口映射，需验证账号、安全、平台和服务条款 |
| [uu-remote-proxy](https://github.com/williampotee-88/uu-remote-proxy) | 通过 UU 端口映射的 SOCKS5 / HTTP 网络出口 | MIT 社区项目；主要面向 Windows，网络代理不等于 SSH 连接 |
| [frp](https://github.com/fatedier/frp) | TCP 和其他服务的反向代理 | Apache-2.0；需可达的 frps，认证与加密配置要单独验证 |
| [rathole](https://github.com/rapiz1/rathole) | 轻量反向 TCP 隧道 | Apache-2.0；上游给出 SSH 配置示例，需可达服务端并正确配置安全传输 |
| [wstunnel](https://github.com/erebe/wstunnel) | 正反向 TCP、WebSocket、TLS | BSD-3-Clause；可研究作为独立进程，服务端仍需可达 |
| [RustDesk](https://github.com/rustdesk/rustdesk) | 远程桌面及 TCP tunneling | AGPL-3.0；TCP 映射能力与嵌入式 SDK 是两件事，需逐平台验证 |
| [EasyTier](https://github.com/EasyTier/EasyTier) | P2P 组网、失败时中继 | LGPL-3.0；经虚拟网地址运行常规 SSH，可能需要系统权限和 Windows 驱动 |
| [Tailscale](https://github.com/tailscale/tailscale) / [Headscale](https://github.com/juanfont/headscale) | 私有网络 / 可自建控制面 | BSD-3-Clause；节点需加入网络，Headscale 本身不是 SSH 或数据中继 |
| [iroh](https://github.com/n0-computer/iroh) | QUIC 直连与中继基础库 | MIT OR Apache-2.0；Rust 库，不是现成 SSH，需单独实现 TCP 桥接及验证 |
| [js-libp2p](https://github.com/libp2p/js-libp2p) | TypeScript P2P 网络组件 | 需要选择传输、认证及 TCP 桥接；Bun 兼容性尚未验证 |

## 回退原则

1. 每个候选必须有已配置、可探测的入口；未安装、未认证或已过期的路径不能标为可用。
2. 对新连接按团队偏好和健康状态排序，并在失败后尝试下一路径。记录每次失败原因。
3. 不同路径如果依赖同一服务器、运营商或账号，可能同时失效；需要标出共享依赖，不能假定它们独立。
4. 已建立的 SSH 会话断开后不能假定透明迁移。任务存续需要在远端采用适当的会话工具或工作机制。
5. SSH 主机密钥和登录身份应跨路径保持一致；不为自动回退关闭主机密钥校验。
6. 失败、拥塞与清理必须有测试。当前原型未达到此条件，不得声称生产可靠。
