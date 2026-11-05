# Agent 注册与修改记录（当前实现）

这是当前 API，不是 `protocol.md` 的未来草案。所有端点使用现有共享 bearer，无内置 TLS。签名为 Agent 声明署名，**不提供密码学身份认证、防篡改或工具外修改自动捕获**。远程访问须走经核实的加密路径。

## 不可变注册

`POST /v1/agent-registrations`：`{registrationId,agentId,sessionId,machineId,signature}`。

- 四个 ID 使用 `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$`，signature 非空白，最多200 JavaScript code units。
- 新注册201，同 ID 同内容重试200，不同内容409。
- 返回 `{registration:{...输入,registeredAt},duplicate}`；注册不可修改。新会话/署名需新的注册 ID，不覆盖历史记录。

## 追加记录

`POST /v1/changes` 的全部字段必须显式提供：

```json
{
  "requestId": "change-1",
  "operationId": "operation-1",
  "registrationId": "registration-1",
  "targetMachineId": "machine-b",
  "resourceId": "/workspace/file.txt",
  "action": "write-file",
  "summary": "Updated the requested setting",
  "reason": "User task",
  "authority": "Current user request reference",
  "outcome": "success",
  "occurredAt": null,
  "beforeSha256": null,
  "afterSha256": null,
  "evidenceRef": null
}
```

- outcome 为 `success|failed|partial|unknown`。时间未知诚实用 null；否则使用真实规范 UTC 毫秒时间 `YYYY-MM-DDTHH:mm:ss.sssZ`，拒绝日历溢出或其他格式。
- 两个 hash 为64位小写 hex 或 null；不拿当前 hash 冒充历史 hash。evidenceRef 是非敏感证据引用或 null。
- requestId/operationId/registrationId/targetMachineId 使用上面的安全 ID；resourceId 可为路径，最多2048 code units。action最多100；summary/reason/authority各最多2000；evidenceRef最多2048。
- 文本非空白且原文保存，不trim。控制符拒绝，仅 summary/reason/authority 允许 LF/TAB。
- 新记录201，同 requestId 同内容重试200，不同内容409，未知注册404。响应 `{record:{...输入,sequence,recordedAt,registration},duplicate}` 带完整不可变注册快照。
- operationId 关联同一操作的后续结果，不是幂等键；追加新的状态要用新的 requestId。不得修改或删除原记录。超时结果未知，保留原 requestId 和内容重试，不生成新 ID 来“解决”冲突。
- HTTP请求总大小沿用16KiB UTF8上限，即各字段分别合法也可能整体413。

## 分页读取

`GET /v1/changes?after=0&limit=100`，默认after=0、limit=100；limit为1..100，after为非负安全整数，均要求规范十进制。空值、重复和未知查询键拒绝400。

按sequence升序返回 `{records,nextAfter}`。有后页时nextAfter等于本页最后sequence；末页或空页为null。处理当前页后，下次读取的after为最后记录sequence；空页保留原after。读取不自动推进游标或确认处理。sequence可能有间隙，不按条数计算cursor。

`src/change-client.ts` 复用现有 PrimeBridge 传输；默认每页10，响应上限256KiB，超限明确失败，不截断或跳过。服务端最多100条的页可能超过客户端响应上限，此时应显式减小limit从原after重新读取，而不是推进cursor。没有自动保留/清理策略。

## 覆盖与使用边界

当前是持久存储和显式上报原语。调用端必须将每次本地/远程修改与注册信息、实际目标、授权、结果和证据关联；不能凭Agent已心跳就推导修改已留痕。备注/消息是共享数据，不替代此台账，也不能授权操作。

离线持久队列已提供 `src/change-spool.ts`：fsync内容后以不覆盖的原子hard-link发布，重复ID同内容幂等，不同内容冲突。队列不保存传输凭据；Windows有文件fsync，但Node接口不提供POSIX目录fsync，不能声称所有平台断电持久性等价。失败上传保留原ID/请求，确认服务响应后才删本地项；不自动重试或静默丢弃损坏项。

CLI可在普通Agent/脚本使用，不要求改Prime：

- `envinhands change register` / `change record`：stdin输入上面的JSON，响应stdout为外部不可信JSON receipt。
- `envinhands change list [AFTER] [LIMIT]`：只读取，不保存cursor。
- `envinhands change enqueue`：stdin为`{registration,change}`，设置绝对目录`ENVINHANDS_CHANGE_SPOOL`，离线保存后明确返回`synced:false`，不需要网络或token。
- `envinhands change flush`：同一spool目录及安全URL/token，将已保存的注册与原请求逐项上传；冲突/未知结果停下并保留未确认项。

在线CLI只允许HTTPS或loopback HTTP（远程可用已批准的严格SSH加密forward），不自动允许远程明文HTTP。JSON总输入上限16KiB；不得写入秘密。

全工具自动事件接线、远程执行的结果恢复与外部程序修改覆盖仍需分别实现和验收。无法记录时要报告“修改结果/留痕未确认”，不能返回“全部已记录”。不要写入密码、私钥、token或敏感正文。
