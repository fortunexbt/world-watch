# Separate inference host

A separately provisioned inference host is proposed, not verified or running. The initial implementation used a Mac that must be awake, authenticated and within quota.

Use a supported Codex installation and that host's own permitted sign-in. Never copy browser sessions or another host's Codex auth store into environment variables or an image. Supply only the worker-scoped application token, the exact backend/service origin and private persistent worker state. Owner, collector and database-admin credentials are unnecessary.

Before allowing work, verify actual host isolation and file-access probes, request limits, quota interruption and persisted spool recovery. If isolation is unavailable, stop. Do not compensate with a privileged container or broad filesystem mounts.

Root `compose.yaml` includes optional analysis profiles. Container execution, Linux isolation and unattended operation have not been validated. Review [operator notes](../docs/operator.md), [Codex notes](../docs/codex.md) and [the backlog](../TODO.md) before using them. Do not run both profiles against the same state volume.
