---
name: fx-dead
description: Grants tools it never uses. Invoke: fx-dead.
disable-model-invocation: true
allowed-tools: [Read, WebFetch, mcp__docs__lookup, mcp__docs__query]
---
# fx-dead
Read the files, then call `mcp__docs__lookup` for the answer.
