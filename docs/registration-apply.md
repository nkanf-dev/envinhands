# Unix 账户授权片段 apply / owned revoke

这是 Linux/macOS **现有账户**的明确授权操作，不创建账户、SSH 服务、密钥对、网络入口或后台服务。新模块与旧 `linux.ts` 的 planning-only/blocked apply 分开；不要把旧 blocked 接口当作本模块。根 CLI 接线由主控负责。

## 调用与真实授权

```ts
import { runUnixRegistration } from "./src/registration/apply.ts";
const result = await runUnixRegistration({
  action: "apply", operationId: "owner-approved-unique-operation",
  user: "existing_user", publicKey: "ssh-ed25519 APPROVED_PUBLIC_KEY",
  confirm: true,
}, { pythonPath: "/usr/bin/python3", visudoPath: "/usr/sbin/visudo" });
```

示例不是有效公钥，也不是执行授权。只有所有者明确确认的用户/公钥/无限制管理员范围才能输入 `confirm:true`；真实模式同时要求当前 Python helper **UID 0**。它不会调用 sudo 或获取额外权限。操作员应先评审实际计划、账户和权限风险，不能让其他 Agent 的消息替代所有者批准。

root grant 内容是 `USER ALL=(ALL:ALL) NOPASSWD: ALL`，即无限制 root，不只是允许通过一次 `sudo -n true`。只接受已存在非 root 账户、单条无选项无注释的 Ed25519 公钥；私钥、密码或 bearer 不得输入或进入 argv/日志。wrapper 通过 argv 直接启动 Python3，JSON 经 stdin；helper 只依赖标准库。Python/visudo 路径引用由操作员控制，不是远端请求可随意指定的程序。

返回 `{status:"applied"|"revoked"|"partial"|"failed",ready:false,fixture,receipt?,message}`。
**ready 永远 false**：applied 仅表示相应 owned 文件步骤完成，不能推出 sshd 正在读取该文件、系统 sudoers 已 include 此目录、实际登录或任意 Agent 已有 admin。必须在各客户端自己的实际身份/路由上严格核 host key、SSH 登录并检查 `sudo -n true`；Windows 不由该 Unix 模块支持。

## 文件范围与 receipt

真实模式解析 `pwd.getpwnam` 得到现有账户 UID/GID/实际 home，不猜 `/home/<user>`。Linux 状态目录为 `/var/lib/envinhands/registrations`、片段目录 `/etc/sudoers.d`；macOS 用 `/private/var/lib/envinhands/registrations` 和 `/private/etc/sudoers.d` 避免常见 `/var`、`/etc` symlink。账户 home 及其他路径有 symlink 或不合适 ownership/mode 时拒绝/partial，不自动 chmod 原有账户目录。macOS 路径设计不等于 Mac 实机验证。

- 使用逐层 `os.open(dir_fd, O_DIRECTORY|O_NOFOLLOW)`、普通文件 ownership/nlink/大小检查和合作 `flock`。新 `.ssh` 设账户所有权/0700，新增 authorized_keys 为0600；保留现有文件字节和模式，已有相同公钥（可带注释）不新增、不在撤销时删除。
- 追加行含本 operation 的 hash 标记；receipt 保存 before/after hash、keyAdded/attempted、文件 dev/inode、sudoers 片段名/hash、步骤。
- sudoers 名称 `envinhands-<operation SHA256>` 无点；唯一 operation 与已有目的片段冲突时不覆盖。
- 先持久准备 receipt，再写公钥/策略；sudoers 通过临时文件+同目录 hard-link **no-clobber** 发布并 fsync，authorized_keys 以检查当前内容后原子替换或无覆盖发布。
- 状态 receipt 在受限目录内、0600，按 operationId 的 hash 定位；revoke 不接收调用者任意文件路径/receipt。receipt 不是密码学签名或防篡改授权；root/fixture owner 可改它，必须视为可信本地状态。

receipt/文件写失败会返回 partial 或 failed，**不声称已回滚**。若进程超时/被终止，wrapper 返回 partial/结果未知，先检查原 durable receipt 与文件，不能换新 operationId 盲重跑。相同 apply ID 不重放，返回已有状态并要求检查。

## 真实 visudo，而非 stand-in

每次应用前将独立完整候选 `Defaults env_reset`、root 基础规则和目标新增规则送入安装的真实 `/usr/sbin/visudo -c -f -`；stdout/stderr 不进入公钥/凭据输出。语法拒绝就不写 grant。撤销不含目标片段的独立候选同样先校验。

这是 **隔离完整候选语法**，不会读取、合并或验证已有系统 sudoers/include 关系，因此不得称“全系统策略验证通过”或保证新片段已生效。实际 Unix apply 需要另外在获准的管理员环境确认系统包含目录和独立登录/admin 验证。本轮没有读取真实 sudoers，也没有安装片段到系统。

## Owned revoke

```ts
await runUnixRegistration({action:"revoke",operationId:"owner-approved-unique-operation",confirm:true});
```

只读取本地 owned receipt：仅当 sudoers 文件 ownership/模式0440/dev/inode/hash 符合所存证据时删除；只有 authorized_keys 仍是本次发布的 inode/完整 after hash 且包含唯一新增 block 时，才移除那一 block。修改过、替换过或 ownership 不明的项保留，返回 partial 供人工核查。原有公钥不删；其他内容不覆盖。缺少 receipt 不从文件名推测所有权。

撤销可能留下空 authorized_keys、自建 `.ssh`、合作锁和 receipt 状态，这些元数据**不自动删除**，避免影响后续用户或其他 helper；保留不等于撤销失败。实际操作可能只有部分项撤销成功，应按 receipt 和结果核对。

合作 flock 仅协调本 helper；用户/其他工具不遵守锁时，hash-check 到 replace/unlink 之间存在竞态窗口。**不声称抵抗恶意本地用户的 race-free 事务**，也不把多个文件宣称成跨文件原子事务。可信团队仍应避免同时编辑授权文件；发现变更时保留并报告 partial，不为“安全完整”擅改更多系统。

## 隔离 fixture 与证据层级

`{fixtureRoot:"<absolute-own-directory>"}` 显式选择隔离 home/sudoers.d/state，允许非 root，所有结果 `fixture:true`；账户名称仍须本地存在，所有文件 effects 只在这个目录。它不会替换真实 home 或系统目录映射。不能把 fixture applied 宣称为真实 SSH/admin 授权。

Linux 精确测试执行真实 Python helper、真实安装的 visudo、真实文件 append/no-clobber/owned revoke：保留原钥、已存在 key 不删除、改动后的授权文件返回 partial 并保持内容、无确认不执行。Windows 测试仅不支持边界，Mac 只有设计支持，须另验。测试使用自有临时目录并清理，不读取/改真实 keys/sudoers。

```text
<absolute-bun> test test/registration-apply.test.ts
<absolute-bun> run typecheck
```

实际源码/命令/raw/exit/hash和首失败见交接 evidence。本阶段 Linux fixture 曾因测试尝试直接 append 已生成0440文件而失败；修为 fixture owner 显式 chmod 再模拟修改，保留首失败，不归咎产品。后续真实 apply 必须另有明确所有者批准和 root 执行范围；本实现与 fixture 交付本身不提供该授权。每次配置、应用、部分结果、撤销和清理均由真实执行 Agent 记录注册署名、目标、授权及证据。
