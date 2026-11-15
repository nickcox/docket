---
name: docket-plugin
description: Docket bb plugin admission controls and limits.
---

Use the Docket CLI for domain operations. This plugin adds no agent tools or
supervisor authority. Its host-service binding is person-controlled; thread
metadata never grants permission.

Launcher commands: `bb docket ready` before thread creation, then
`bb docket recheck <threadId>` only to request fresh admission evaluation.
A recheck is global in SDK 0.6.132 and is not evidence of admission. Never use
Send now or `bb thread queue send` to release Docket work.

Configure `executable` (no shell arguments) and secret `binding` through
`bb plugin config docket set`. Everything runs on one machine. The launcher
passes the leased Treehouse path to bb's checkout environment. Only Docket
controls the lease and its return; bb's environment record can outlive it.

Readiness checks registration, nonblank settings and the binding's admission
catalogue, not live qualification. CLI sends must not inherit BB_THREAD_ID. The core matches
exact text and author category user against single-use recorded sends, not bb's
generated queue IDs. An identical copy arriving first consumes the send in its
place. No correlation marker is added to message text.

This plugin remains live-unqualified. Disabled/unloaded/replaced hooks and direct queue
sends can bypass admission; later turns can modify even returned workspaces.
Workers retain the person's normal provider settings, resources and tools.
See the plugin README for installation and the complete R33/R34 limits.
