---
name: fx-readonly
description: Read-only readiness check; never writes anything. Invoke: fx-readonly.
disable-model-invocation: true
allowed-tools: [Read, Glob, Grep, Bash, Write]
---
# fx-readonly
Run `git status` in each repo. Writes nothing but a chat report.
