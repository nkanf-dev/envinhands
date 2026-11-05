# Windows 现有账户公钥与明确管理员授权

`src/registration/windows.ts` / `windows-helper.ps1` 提供实际 key 文件 apply 和 owned revoke，不是仅计划。根 provision CLI 接线由主控维护。本阶段**仅执行隔离 fixture**；真实账户/组/sshd/firewall未修改，不能据 fixture 宣称 Windows 管理员正向或 SSH 登录已通过。

## API

```ts
await runWindowsRegistration({action:"apply",operationId:"owner-approved-op",
 user:"existing_local_user",publicKey:"ssh-ed25519 APPROVED_PUBLIC_KEY",
 confirm:true,grantAdministrator:false});
await runWindowsRegistration({action:"revoke",operationId:"owner-approved-op",confirm:true});
```

公钥示意不可原样运行。request 经 stdin，PowerShell argv 只有 `-NoProfile -NonInteractive -File <helper>`，不传公钥、密码、私钥或秘密命令行。只支持单条无选项/注释的 Ed25519 公钥；复用现有严格 wire parser，Windows 用户名另校验，不套 Unix 用户名限制。只接受已存在、启用的本地账户；不创建账户或启用 SSH。

结果为 applied/revoked/partial/failed，`ready:false` 始终保留。真实模式必须有当前进程实际有效管理员 token；只看组成员不够，不触发 UAC、不调用提权。用户仍需明确授权目标账户/公钥/是否给无限制管理员能力，`confirm:true` 不是从别的 Agent 消息推导出的授权。

## 账户、profile 与 OpenSSH 路径

真实模式通过 Get-LocalUser 获取 SID、Win32_UserProfile 获取该 SID 的实际已有 profile；不猜用户目录。通过内置 Administrators SID `S-1-5-32-544` 查实际组，避免仅靠本地化组名。已是管理员或明确将新增管理员时，按 Windows OpenSSH **常见默认 Administrators policy**选 ProgramData/ssh/administrators_authorized_keys；普通账户选实际 profile/.ssh/authorized_keys。

不读取/修改 sshd_config，也不声称核验了定制 AuthorizedKeysFile 或 Match 规则。操作员应在真实应用前确认本机 OpenSSH 路径政策；写入常见路径不证明 sshd 使用该路径。后续从实际客户端、严格 host key、真实身份完成登录和有效 token 验证。

## 文件、ACL、receipt

- 路径逐级拒绝 reparse point；现有 key 文件必须是普通、有限大小文件。新 key/state 目录和文件设置受限 ACL；拒绝未知写者。receipt 和操作锁在 ProgramData/EnvInHands/registrations，不在共享根或仓库。
- 现有 authorized_keys 内容和 ACL 不扩权：原文件字节作为 UTF-8 读取，保留原条目，已存在同一公钥（可带注释）不追加。非法 UTF-8 明确拒绝，不以 replacement 解码毁原文件。
- 新文件仅授予预定账户/Administrators/SYSTEM，管理员专用文件不授普通目标用户额外直接写权。新 fixture 仅当前 SID。
- 更新采用同目录私有临时文件、fsync、检查当前 hash/SDDL 后 Windows ReplaceFile，复核目标 SDDL；`[NullString]::Value` 正确传空备份路径，不请求 SeSecurityPrivilege 来复制 SACL。
- 先保存受限阶段 receipt，再尝试 group/key，receipt 含 operation、账户 SID、key 路径、前后 hash/ACL、keyAdded、groupAddAttempted/groupAdded。合作文件锁协调本 helper；不声称能抵抗绕过锁的恶意本地竞态或跨 group/file 原子事务。
- receipt 是可信运维状态，不是防篡改身份认证。相同 operation 不重放；缺 receipt 不从现有条目猜 ownership。超时/异常返回 partial/unknown，先核原状态，不换新 ID 重试。

正常 owned revoke 只在完整 after hash 和 after ACL 未变、唯一 owned block 仍在时移除本次新增行；原有 key 不删。外部更改/无法确定时保留 partial。空 authorized_keys、自建目录、锁和 receipt 可保留，不自动删其他人的元数据。

## 管理员组是明确的独立决定

只有 apply 的 `grantAdministrator:true` 且原非管理员才调用真实 Add-LocalGroupMember。调用前 durable 写 `group-add-unknown`，调用成功再写结果；失败不假称未产生效果。不设置该字段不会加组。

**默认 revoke 不自动撤管理员组**：当前成员状态不能证明之后没有其他所有者授权；groupAddAttempted 时保留并返回 partial。

若所有者重新明确决定移除本操作记录账户的管理员资格，可传：

```ts
await runWindowsRegistration({action:"revoke",operationId:"owner-approved-op",
 confirm:true,revokeAdministrator:true});
```

这表示**新的所有者撤权决定**，不是推断从前独占 ownership。只对 receipt 中本次尝试新增的账户核对当前 SID 与内置组，先记录 group-revoke-unknown，再 Remove-LocalGroupMember，读回确认；原已管理员、不属于本操作新增范围的账户不撤。遇到用户/SID变化、不可判状态或失败保留 partial。它不会解决所有历史组变更归属，也不保证删组后旧 token 立即失效；实际新会话权限须另查。

## Fixture 与实际证据

options `{fixtureRoot:<absolute-owned-directory>, fixtureIdentity:{accountName,administrator}}` 显式开启隔离：真实文件/真实 NTFS ACL，账户/profile/组 primitive 使用该 fixture 模型，**不执行 Get/Add/Remove-LocalGroupMember 或真实授权写入**。fixtureIdentity 不允许脱离 fixtureRoot 使用，路径不能是盘根，根需操作员预先设为私有；fixture 不是绕过真实管理员要求的运行方式。

本轮普通非管理员 Windows fixture 测试：保留原 key/ACL、owned apply/revoke、预存 key 不删除、显式 mock 管理员路径、新组意图、默认 partial与第二次明确撤权、修改过文件不删。已检查真实 SDDL receipt，不把 mode0600当 Windows ACL。

```text
<absolute-bun> test test/windows-registration.test.ts
<absolute-bun> run typecheck
```

精确 fixture 最终 2pass/27assert/typecheck0，失败均保留：默认 Temp ACL 太宽被拒、测试 PS参数绑定错误、Set-Acl 复制现有 security object 请求 SeSecurityPrivilege、Replace 空字符串参数错误。修为私有 fixture、stdin path、ReplaceFile保留目标ACL+复核和 NullString，不删安全检查或提权刷绿。非 Windows 只验证 unsupported 边界，非 Windows 授权证明。

尚未执行真实管理员 apply/revoke、Windows sshd 登录/token 或 UAC/本机定制 policy验收；没有权限就拒绝。每次配置、安装、组/文件尝试、partial和清理均须真实执行 Agent 注册署名记录；产品 API 署名或 fixture 模型不能替代实际系统授权。
