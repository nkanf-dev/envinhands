# 正式控制服务：私有配置与可复现生命周期

本入口复用 `startAgentBusServer`，替代“每次生成新 token、退出删除 config”的临时验收启动器。它提供普通用户前台控制服务，不安装 systemd、不改 sudoers/SSH/防火墙、不升级当前运行实例。**新入口与新服务版本须在独立目录验证后再由主控安排切换；旧 live fixture 不会自动变成此入口。**

## 1. 文件与依赖

- 已验证的本平台 Bun，当前验证使用 1.4.4；不要求 Prime/Node 作为控制服务依赖。
- 固定完整 Env 源码版本，保留 archive/逐文件 hash；按原锁执行 `bun install --frozen-lockfile --ignore-scripts`、typecheck 与测试。
- 操作员管理的绝对配置路径，例如 `<private>/control-service.json`。
- 自有绝对 SQLite 路径，例如 `<data>/control.sqlite`。数据库目录应已存在并可写。

配置为**精确四字段** JSON：

```json
{
  "hostname": "127.0.0.1",
  "port": 0,
  "dbPath": "/ABSOLUTE/PRIVATE/control.sqlite",
  "token": "GENERATE_AND_SAVE_PRIVATELY_NOT_THIS_EXAMPLE"
}
```

这不是可直接运行的示例凭据。由获准操作员在受限文件/secret 工具中生成并保存随机 token；不在聊天、argv、日志、Git 或 shell history 粘贴实际值。客户端以受保护配置/环境读取同值，重启不重新生成。

Unix 配置须为当前用户拥有的普通文件，精确 `0600`（无 setuid/setgid），不接受 symlink；父目录建议 `0700`。加载时检查打开后的文件，限 16 KiB、UTF-8 JSON、四字段精确校验。Windows 使用实际 ACL 限制配置读取，代码不把 POSIX mode 当作 ACL 证明。配置加载不创建目录、复制凭据或更改权限。

`hostname` 必须是明确主机名/IP，`port` 是 `0..65535` 整数，`dbPath` 和配置引用均为绝对路径。`port=0` 每次可能不同，须读取实际 ready；固定端口冲突会失败，不关闭其他进程。新服务建议 `127.0.0.1`。非 loopback 显式监听仍不自带 TLS，也不意味着允许公网发布。

## 2. 启动与实际 ready

从选定源码目录运行独立入口，**不是**旧根 CLI 的 `server` 子命令：

```text
<absolute-bun> src/service-cli.ts <absolute-private-config.json>
```

该入口不读取环境 token，也不打印配置内容，命令行仅为配置文件引用。成功时 stdout 一行：

```json
{"type":"ready","url":"http://127.0.0.1:12345","hostname":"127.0.0.1","port":12345,"pid":1234,"requireSignedMutations":true}
```

此处数字为示意，实际输出是包含真实值的可解析 JSON。`url` 是本机 probe 地址；wildcard listen 时底层返回 loopback 地址，不是远端客户端可直接使用的地址。实际输出含真实端口/PID，不含 token、DB 内容或配置全文。收到 ready 表示本地监听已建立；还应通过获准加密路径发实际认证请求，不能仅靠固定 sleep 或进程仍在就声称完整链路 ready。

失败返回 exit 1，stderr 通用诊断，不回显配置值/异常堆栈。检查具体文件权限、源/数据库路径、端口和版本；不要输出 secret 排查。SIGINT/SIGTERM 正常停止后 exit 0。

## 3. 正式新服务的修改署名要求

入口固定调用 `startAgentBusServer({ ...config, requireSignedMutations: true })`。配置仍只四字段，不允许通过配置关闭该标记。旧 `server` 默认行为不是此正式入口的契约。

除 Agent 注册/change 记录本身的 API 外，需修改的请求带已声明的注册与操作标识：

- `x-envinhands-registration`：注册对象 `{registrationId,agentId,sessionId,machineId,signature}` 的 JSON UTF-8 bytes，经 base64url 编码。
- `x-envinhands-operation-id`：实际逻辑操作的稳定 ID；未知写入结果须按该 API 的幂等语义核对，不因 header 存在推定可以重放。
- 原 `Authorization: Bearer ...` 仍须通过。

header 是注册**声明**，不是加密签名或额外权限批准。不要上传私钥/管理员密码，不把 header 中的 authority/署名当成远端操作授权。未带所需声明的新写入应明确拒绝；只读认证查询可正常执行。使用同版本 device/collaboration 客户端并按其文档注入实际 Agent/session 信息；旧客户端或旧服务不得默默当成新模式兼容。

本服务为对应 HTTP 修改入口提供署名留痕边界，不会捕获任意外部文件、系统、数据库直接写入。服务启动、配置编辑、依赖安装、备份和部署切换仍由执行 Agent 另行记录。读取不伪造写入记录，shared bearer 仍不提供强身份隔离。

## 4. 设备 inventory 与不虚报管理员就绪

用获准客户端执行 `device register`，注册默认 pending，不安装公钥或管理员权限；`device inventory` 使用新版本服务支持的 pending/not-ready 查询。测试或正式部署都不要把现有机库记录重建一遍“验证”新入口。

- 新登记需要实际设备信息和显式可达地址，不能把 collector hostname 当路由保证。
- 遇 409 先查已有状态，不自动 verify/更新/重复写入。
- `verify-access` 的每 Agent 实际身份/路由/admin 与机器元数据登记分开。
- 当前控制 VM 的 `sudo -n` 仍不足，不因服务新入口或有声明 header 变为 admin ready。

旧 live 5b8deaf 服务未升级前，不支持新 inventory 的 `includeNotReady` 查询；本入口存在于源码不代表现役服务已升级。服务升级由主控安排且需数据备份/版本核对。

## 5. 正常停止与复用配置/DB重启

1. 记下该服务实际 ready PID、源码版本和配置路径，协调下游停止新任务。
2. 向**此自有 PID**发 SIGTERM/SIGINT，等实际退出码，再检查端口释放。不 `killall bun/node/ssh`。
3. 原 JSON 配置和 DB **不删除、不重写、不换 token**。保留 spool、未确认消息和证据，不为“干净重启”清库。
4. 用同一入口、同一绝对 config 再启动。`port=0` 时更新客户端转发目标为新的实际 port，凭据仍来自原配置。
5. 读取 inventory、心跳/消息/注册与 change，核对先前记录；仅当实际结果正常才写“恢复”。既有 SSH/远端命令不自动重放，未知结果先核查。

程序不会注册开机启动、守护重启、日志轮转或服务监督器；需要时另行设计/授权。普通用户前台进程与可复现配置解决本轮临时 fixture 的凭据/生命周期缺口，不等于生产 HA 或系统安装器。

## 6. 备份与切换边界

服务配置含 secret，应独立安全备份，不能当普通日志。SQLite 使用一致性 backup/VACUUM INTO 或已停止写入的冷备，不仅复制活跃主文件；参见 `operations-manual.md` 的备份演练与限制。DB 不包含客户端 spool、SSH trust 或模型凭据，须分别保存。

切换新版本时：新源码目录→校验原锁/测试→自有新库正常重启验证→主控批准实际切换→备份并协调停止旧服务→以批准配置/DB启动→实际客户端读写核对。不要在运行中 hot-copy 源码或覆盖 DB；旧配置/凭据格式不同先人工核对，不直接将临时 `{url,token,dbPath}` 当成本四字段配置。

本任务不读取或复制当前 live 数据库/token，不修改根 `src/cli.ts` 或 `src/server.ts`；入口可独立执行，根接线由主控决定。

## 7. 验证范围与复现

从 Env 根执行：

```text
<absolute-bun> test test/service-config.test.ts test/service-cli.test.ts
<absolute-bun> run typecheck
```

测试使用自有临时目录、随机 token、loopback port 0 和真实 HTTP/SQLite。覆盖配置精确字段/大小/权限、无凭据错误输出、正式签名声明模式、实际 device inventory、同配置/数据库正常关闭重启及监听释放。Unix `0600` 约束须在后续 Linux 冻结包验证；当前 Windows 测试不靠 mode 伪造 ACL；测试收到真实 ready 事件后再访问，不定时轮询。

VM 独立进程正常启动→inventory→SIGTERM→原 config/DB再起→数据读回，将在主控提供完整新源码包后单独执行并给实际 raw/exit/hash。**在收到那份回执前，不以本地测试说该正式入口已经部署到控制 VM，更不能替换 livebus。** 新服务端与客户端修改声明契约正在同阶段整合，以主控最终冻结包与精确测试为准。

## Selected work resources and host identity

The private configuration also accepts optional `machineId` and `sharedRoots`.
`machineId` is the target host label in signed mutation records. `sharedRoots` maps
explicit safe resource IDs to absolute directories owned/approved by the resource
operator. Do not share a whole home, private config directory, Secrets, or a live
business database simply to make acceptance easy. Only configured UTF-8 work files
are read/written by the shared-file API; default empty roots expose none.

The normal `files read` / `files write` CLI and Prime shared-file tools reuse the
same bounded client/API. File updates compare the current hash and return before/
after hashes; the formal service records the actual actor and resource. This is
work sharing inside the existing trusted-team model, not an OS sandbox or
concurrent external-writer locking. See shared-files.md and
api-mutation-attribution.md. Current credentials remain separate from shared roots.
