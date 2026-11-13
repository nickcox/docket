---
name: docket-plugin
description: Docket bb plugin admission and recorded-allocation controls and limits.
---

Use the Docket CLI for domain operations. This plugin adds no agent tools or
supervisor authority. Its host-service binding is person-controlled; thread
metadata never grants permission.

Launcher commands: `bb docket ready` before thread creation, then
`bb docket recheck <threadId>` only to request fresh admission evaluation.
A recheck is global in SDK 0.6.132 and is not evidence of admission. Never use
Send now or `bb thread queue send` to release Docket work.

Configure `executable` (no shell arguments) and secret `binding` through
`bb plugin config docket set`. Everything runs on one machine. Environment
provider `docket` takes only the recorded `leaseId`, returns its verified path
and refuses removal. Use Docket core return operations instead.

This plugin is unqualified and queue identity compatibility remains unresolved.
Do not activate real workers. Disabled/unloaded/replaced hooks and direct queue
sends can bypass admission; later turns can modify even returned workspaces.
Workers retain the person's normal provider settings, resources and tools.
See the plugin README for installation and the complete R33/R34 limits.
