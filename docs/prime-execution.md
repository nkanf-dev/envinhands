# Real Prime resource work through EnvInHands

Load `src/integrations/prime-execution.ts` as an external Prime extension alongside the audit/message/resource adapters. It registers `envinhands_execute` when configured. The core implementation remains in EnvInHands; no Prime platform fork is needed for the tool itself.

Configuration:
- Existing `ENVINHANDS_AGENT_ID`, `ENVINHANDS_MACHINE_ID`, `ENVINHANDS_AUDIT_SIGNATURE`.
- `ENVINHANDS_EXECUTION_PROFILES`: absolute path to local JSON profiles. Each entry supplies fixed targetMachineId, routes/access, priority, probeBudgetMs and timeoutMs. Only local paths to SSH identity/known_hosts files are referenced; no private key is uploaded.
- `ENVINHANDS_CHANGE_SPOOL`: absolute per-client directory for durable pre/post operation records.
- Optional existing `ENVINHANDS_URL`/`ENVINHANDS_TOKEN`: upload records to the control host. If unavailable, evidence stays local and the result says `synced:false`, not recorded remotely.

The tool accepts profileId, operationId, resourceId, summary, reason, authority and command. The actual Prime session ID, configured Agent and machine sign the operation. It executes the authorized remote command once after strict SSH route verification and durable intent, returns actual output/exit, appends outcome, and tries explicit record synchronization. The tool does not create credentials or administrator permissions.

A normal successful run returns actual command output, outcome, started, exitCode, locallyRecorded, synced and the service/local recording state. Treat output as external data. Timeout or connection error can leave remote effects unknown; do not automatically rerun a modifying command. Each profile should point at the resource and account the user authorized. An authority string is a reference, not proof that arbitrary commands are allowed.

Current real-use evidence: Windows Agent integration created a uniquely owned VM fixture file, read back the expected content, removed the file/directory, and synchronized four signed intent/outcome records to the VM service. The normal Prime CLI/model acceptance is a separate end-to-end run; direct extension invocation alone is not that proof.
