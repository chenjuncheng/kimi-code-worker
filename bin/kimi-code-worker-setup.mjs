#!/usr/bin/env node
process.argv.push("--setup");
await import("../src/kimi-code-worker-mcp.mjs");
