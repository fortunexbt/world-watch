# Security

Europe Watch is an unfinished prototype and has no declared supported production release or security response SLA.

Do not put credentials, private watch locations, personal information or complete exploit captures in a public issue. For a suspected exposure, stop publishing the affected material, preserve a private copy for investigation, and contact the repository owner through an established private channel. If GitHub private vulnerability reporting is enabled, it can be used; its availability is not assumed here.

Removing a file from the latest tree is insufficient when a secret was committed. Revoke or rotate real credentials, inspect every published ref and coordinate history/cache removal as needed. This cleanup found provider metadata and source captures; exact comparisons against the installation's current private credential values found no historical match. That is a scoped audit result, not a guarantee that every possible secret is absent.

The application separates owner, collector, worker and optional hosting-service credentials. Keep service-origin pinning, redirect denial and extraction isolation intact when changing configuration. Treat source text and model output as untrusted. See [architecture](docs/architecture.md) and [the security backlog](TODO.md).
