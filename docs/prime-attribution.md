# Prime automatic tool-execution attribution

Load `src/integrations/prime-attribution.ts` as an explicit external Prime
extension. It uses actual `on("tool_call")` and `on("tool_result")` hooks, rather
than asking the model to remember a recording tool. No Prime platform change or
new dependency is needed.

Required environment: `ENVINHANDS_AGENT_ID`, `ENVINHANDS_MACHINE_ID`,
`ENVINHANDS_AUDIT_SIGNATURE`, and an absolute per-client
`ENVINHANDS_CHANGE_SPOOL`. Missing configuration leaves the extension disabled.
Each actual context's `sessionManager.getSessionId()` creates an immutable
registered identity declaration. It is not cryptographic authentication.

Before a tool runs, the awaited call hook publishes a fsynced intent through
`ChangeSpool`. If this fails, it returns the real hook's block result: that tool
does not start. After execution, the result hook appends a separate outcome with
the intent as its predecessor. Completion failure keeps the unknown intent,
adds a visible warning/error result and never reruns work.

Both events use action/scope **`tool-execution-observation`**. Success means the
tool returned without an error, not proof that a filesystem or remote mutation
succeeded. Error means the tool returned an error; partial side effects are not
inferred away. If the process crashes or an event is never delivered, the durable
intent remains unknown. The adapter does not infer missing outcomes.

## Data minimization

- Full tool input is hashed in memory as SHA256. Only the digest is recorded.
- `edit` resolves its known local path against actual `ctx.cwd`, then checks
  bounds, control characters and known service/model key values before opening it.
  For a regular readable file, SHA256 is streamed before dispatch and after the
  result, without storing file contents or old/new text. Error results still
  record the actual readable after-hash: a failed edit can have changed a file.
  Missing, nonregular or unreadable files have null hashes; null is not proof of
  absence or unchanged contents. No unbounded readBuffer is used for large files.
- bash, ipython and custom tools use a hashed `tool-call:` reference. The adapter
  does not guess which files, machines or remote resources a command/code touches.
- Python code, shell command text, output, tool details and sensitive bodies are
  never stored in observation records. Known keys are not copied into identity
  or path fields. Hashes are not encryption; don't treat them as a secret store.
- The execution machine labels the observation source, not an invented remote
  mutation target. An explicit remote execution record supplies real target data.

Existing `envinhands_register_agent`, `envinhands_record_change`,
`envinhands_list_changes` and `envinhands_execute` are excluded to prevent audit
recursion and duplicating the execution tool's existing durable boundary. Other
calls, including read-only tools, are observations; no false mutation claim is
made. Loading attribution after other argument-mutating tool hooks records their
final input. A later hook can still block/change execution; this extension cannot
promise it observed an OS-level operation.

## Local durability and upload

There is no network request in the pre/post execution hooks. They only wait for
local durable records. `agent_end` and `session_shutdown` independently attempt
explicit `ChangeSpool.flush` through `ChangeClient` if service URL/token exist.
The default is a two-second request deadline. HTTPS or loopback HTTP is required;
an approved SSH forward can provide loopback access to the VM. No public bind,
credential setup or privilege change occurs.

UI status clearly distinguishes locally pending vs service-receipted records.
Network/upload failure retains exact local IDs/content and emits a warning;
commands are not replayed. A new runtime's lifecycle sync also checks an existing
spool. This is lifecycle-driven upload, not a background retry scheduler.
If there is no UI, the host may ignore status rendering; failed durable completion
also adds a text warning to the actual tool result. Operator can explicitly use
the existing change flush CLI for retained records.

## Test and coverage

From EnvInHands with prepared Bun:

```text
<absolute-bun> test test/prime-attribution.test.ts
<absolute-bun> run typecheck
```

The small fixtures check actual disk intent before a real owned file write,
ordered completion and actual HTTP/SQLite receipt, omission of private input/output,
exclusion of existing audited tools, blocked intent and offline pending records.
Known-edit fixtures also check successful modification, error after a real change,
missing/nonregular files, exact input digest and no content in records.
A separate implementing-agent probe loads this exact extension through Prime's
real loader and emits actual `ExtensionRunner.emitToolCall/emitToolResult`, then
observes the real service records. The main coordinator separately connects this
to normal CLI use; runner-level tests are not full CLI acceptance.

This covers the current Prime tool-event path only. It is **not** a global file
watcher, all-OS audit, automatic detection of arbitrary Python/external writes,
SSH process monitoring, or complete causal resource attribution. A single tool
can modify many resources. Known local edit adds observed before/after file hashes,
not atomic snapshots or proof that this tool alone caused every difference.
Concurrent writers can affect a hash and symlinks follow normal local file access;
these observations do not provide a filesystem lock or remote-file attribution.
Out-of-band shell/UI/process writes, tools bypassing this host, unobserved agent
processes and already dispatched work need their own traceable boundaries.
