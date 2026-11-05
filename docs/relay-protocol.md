# Relay protocol v2：方向 FIN 与受控半关闭

此版本是 relay、node 与 proxy 的**显式不兼容线协议升级**。三端应成组使用同一版本，保持控制面/业务消息 API 不变。本阶段不替换已有运行实例；主控在新快照上另做真实 SSH 回归。当前 HTTP/共享文件路径原有可用性不因 relay 升级被否定。

## 版本与握手

- node/client/channel URL 都由内部 `relayEndpoint` 添加单个 `v=2`，调用者仍配置不含 query 的原 base `ws://`/`wss://` 地址。
- relay 在 WebSocket 升级前拒绝缺版本、其他版本或重复 v，返回 400，不占注册/session 槽。认证仍先检查，错误 bearer 为 401。
- node 控制注册响应 `registered-v2`；connect 通知为 `{type:"connect",id:<session>,version:2}`；channel 连接目标 TCP 后发送 `ready-v2`，relay 再把此 marker 发给 client。
- 旧 `registered`/`ready` 不接受，不静默 legacy fallback。不得因一次旧端成功建立 TCP 就宣称已支持半关闭。
- 所有数据 binary frame 仍是不透明 SSH/TCP 字节，不解释其协议、身份或任务。

## 两个方向的 EOF

ready 之后仅允许两种文本控制帧：

| 帧 | 含义 |
|---|---|
| `fin` | 发送方此方向的所有 binary 已按序发送，不再发送新 binary；反方向仍可继续。 |
| `fin-ack` | 接收方已将前序数据排空到下游接受边界，并施加/观察该方向 EOF。不是远端应用已读、处理或持久化。 |

发送方 FIN 和相反方向 ACK 是不同状态，不能互相代替。重复 FIN/ACK、未收到对应 FIN 的 ACK、未知文本或 FIN 后 binary 导致异常关闭，不能制造完成。WebSocket 同方向消息顺序让 FIN 位于此前数据之后。

relay 追踪 clientFin/nodeFin/clientAck/nodeAck，且**仅 relay**在双向 FIN/ACK 齐备后正常关闭 WebSocket。若仍有活动 session 的任意端提前以 1000/1005 关闭，relay 也向另一端返回异常 1011，不以正常 close 码伪造方向完成。端点不能在第一向 EOF 时关闭 WS，否则会丢失“请求 EOF 后才产生”的回包或最后 ACK。节点控制连接断开、setup/缓冲/方向完成超时或 TCP 错误导致异常终止；不重放已开始命令。

## Node TCP 与真实 Bun 行为

node 使用 `Bun.connect({allowHalfOpen:true})`。client FIN 到达后，真实 partial `tcp.write` 队列经 drain 接受完毕，调用 `tcp.shutdown(false)` 明确结束写方向，再发 ACK；继续读取和转发对端响应。不能用过去的 draining 标志丢弃回包。

目标 TCP `end` 表示对方 FIN，已收 TCP 数据排入 WebSocket 后发 node FIN。目标先 FIN 时，client→目标方向仍可发送剩余请求。Bun 在双方方向完成时可能只触发 `close` 而没有额外 `end`；当自己的写方向已正常关闭，接收侧 close 按完成方向发 FIN，保留通道等待最后 ACK。含 error 的 close 或不满足预期的 close 仍异常中止。

本轮真实 Windows Bun 1.4.4 观察中，`Socket.end()` 可立即触发 close；使用明确写侧 `shutdown()` 并处理预期 close 才完整通过方向场景。Linux 也运行同一聚焦测试，不只依赖类型声明。

## Proxy 与输出所有权

`startSshProxy` 返回 Promise，参数仍用原 base URL/nodeId/secret/input/output；新增 `onRemoteEnd?:()=>void`。

- input EOF 先排空原队列，再发 FIN，继续收回包；不会为 EOF 提前 close WS。
- 收到远端 FIN 等 `output.write` callbacks 排空，再调用可选 `onRemoteEnd` 一次并发 ACK。
- **默认不调用 output.end 或 process.stdout.end**，因为输出由调用者拥有。TCP bridge 调用者可在回调中主动结束其 socket 写侧；输入一侧仍可独立完成。
- Promise 只在双向状态完整、relay 正常 close 且本地输出排空后 resolve；否则明确 reject。回调抛错也 reject。

完成最多证明 bridge 接受/排空和有序 EOF，不等于应用业务完成。SSH 退出码、命令输出与任务状态仍由上层核对。

## 预算、停止与边界

保留原单帧 1MiB、节点/服务缓冲 4MiB、proxy 输入/输出 pending 4MiB、高低水位和 setup 预算。控制帧也受发送缓冲限制。首方向 FIN 后启用现有有限 10s 完成/排空界限，不给正常长连接加随意总寿命。满缓冲、错误和超时 abort，不无限积压；proxy 输出错误监听保留到已派发 write callback 完成。

node-runtime 的对外参数和重连策略不变；直接构造 WS 的测试/外部客户端必须用 v2 URL/marker。节点重新注册只能恢复新连接机会，不迁移旧 SSH 流、不重放远程命令。共享 bearer/secret 仍非逐身份认证，无内置 TLS；不可信链路应使用获准的 WSS 或加密承载，不能因此开放公网。

## 实际原生验证与限制

既有 `test/relay.test.ts` 与 `test/ssh-proxy.test.ts` 覆盖真实 loopback：binary/server banner、认证/缺 node、槽/缓冲/异常、FIN 后 data 拒绝、legacy 拒绝、请求 EOF 后才返回 1MiB 响应、远端 FIN 之后客户端仍送剩余请求、低 highWaterMark 异步 output callback 排空以及不自动结束 output。真实 `allowHalfOpen`、write/drain/end/close 顺序参加断言，不是控制帧 mock 自证。

先添加新方向测试实际红：原实现无法收到 EOF 后响应/不触发 remote-end，首 raw 保留。实现早期真实 Bun close/FIN 时序失败也保留，未临时破坏生产源码制造负控，未通过放宽断言刷绿。最终 native counts/类型/hash 见本阶段交接报告；root 的 node-runtime 直接 WS fixture 只需更新两 URL 的 `&v=2` 与 `ready-v2`，生产 node-runtime 不改。

此结果不证明所有 TCP 应用/负载/OS、任意公网、无损迁移或任务 exactly-once。真实 compiled CLI 通过已授权 SSH 的最终回归由主控新完整快照单独验收；在该回执前不把本地 echo 当真实 SSH 已通过。已有 bus、relay 或工作服务不在本轮自动升级。
