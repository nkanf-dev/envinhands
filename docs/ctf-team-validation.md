# Owned CTF team acceptance

The actual Prime CLI launcher supports `ENVINHANDS_CTF_CONFIG`, pointing to a private JSON fixture configuration with a team ID, Windows static source path, VM challenge directory, configured SSH profile ID and three participants' independent user requests. Use actual-model mode. Each participant has a separate session, workspace, config and own tool-observation spool.

The controller does not prescribe a leader, peer-message contents, candidate, decoding result or flag. It supplies the common100-point goal and each user's scope, lets the real model choose tools and negotiate, and gives participants subsequent work turns. Static-only users are not given a remote execution profile. Local source is exposed through the read-only `prime-files.ts` adapter; dynamic users use the VM execution profile. The owned challenge has no external target or network exploitation.

Scoring is performed by the actual VM checker. The controller reads the checker result using the same configured strict SSH route and accepts only the team's observed100points. Evidence includes real Agent tool results and peer messages, not internal development-agent messages or a controller-injected answer. The automatic attribution adapter observes normal dispatched tools; the execution adapter separately records remote intent/outcome and synchronizes them. These records do not infer every external or detached process write.

This is an explicit, bounded multi-user result-oriented scenario. Different user restrictions remain authoritative even if another Agent asks to exceed them. Three instances on one Windows host simulate distinct users; the VM is the real separate resource/service host. Broader physical-device/network coverage remains separately tracked.
