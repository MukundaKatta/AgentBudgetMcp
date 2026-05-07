# agentbudget-mcp

MCP server for [`@mukundakatta/agentbudget`](https://www.npmjs.com/package/@mukundakatta/agentbudget). Exposes token + dollar budget caps to any MCP-aware client (Claude Desktop, Cursor, Cline, Windsurf, Zed) so agents can track spend across tool calls and refuse work that would push past the ceiling.

## Install

The cleanest path is to let your MCP client launch the server via `npx`:

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentbudget": {
      "command": "npx",
      "args": ["-y", "@mukundakatta/agentbudget-mcp"]
    }
  }
}
```

**Cursor** — `~/.cursor/mcp.json` or `<project>/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agentbudget": {
      "command": "npx",
      "args": ["-y", "@mukundakatta/agentbudget-mcp"]
    }
  }
}
```

Same shape works for Cline, Windsurf, Zed — point at the `@mukundakatta/agentbudget-mcp` package over stdio.

## Tools

The server exposes three tools that share one in-memory budget for the duration of the MCP session:

### `configure_budget`

Set the active caps. Calling this replaces any existing budget; totals reset to zero.

| Argument                | Type    | Notes |
| ----------------------- | ------- | ----- |
| `max_input_tokens`      | number  | optional — cap on cumulative input tokens |
| `max_output_tokens`     | number  | optional — cap on cumulative output tokens |
| `max_total_tokens`      | number  | optional — cap on input + output combined |
| `max_cost_usd`          | number  | optional — cap on dollars; needs pricing |
| `pricing`               | object  | optional — per-model `{ inputPer1k, outputPer1k }` map; falls back to the built-in starter table |
| `allow_unknown_pricing` | boolean | optional — when true, models with no pricing cost $0 instead of erroring |

### `record_llm_usage`

Tally one LLM call. Call this **after** the response — by the time you have token counts, the call already cost money.

| Argument        | Type   | Notes |
| --------------- | ------ | ----- |
| `model`         | string | required when `max_cost_usd` is set |
| `input_tokens`  | number | required |
| `output_tokens` | number | required |

Returns one of:

- `{ "status": "ok", "totals": {...}, "remaining": {...} }` — call accepted
- `{ "status": "exceeded", "cap": "...", "limit": ..., "attempted": ..., "overshoot": ..., "totals": {...} }` — a cap tripped. **This is data, not an MCP error** — your agent can read it and decide what to do (fall back, summarize, stop).

### `budget_status`

Peek at current totals + per-cap remaining. Useful for letting the agent decide whether to schedule more work.

## Why an MCP server?

You can use [`@mukundakatta/agentbudget`](https://www.npmjs.com/package/@mukundakatta/agentbudget) (or its [Python sibling](https://pypi.org/project/agentbudget-py/)) directly inside your own agent code — that's the lower-friction path.

This MCP wrapper exists for two cases:

1. **Cross-tool budgets**: when several MCP-spawned tools share one session, this server keeps a shared spend counter that no individual tool owns. Useful for caps like "do not exceed $5 across this whole session, regardless of which sub-agent runs."
2. **Client-driven enforcement**: when the *client* (Claude Desktop, Cursor) is the one driving model calls and you want a budget surface the operator can configure declaratively without modifying agent code.

Otherwise, prefer importing the lib directly.

## Sibling libraries

Part of the [`@mukundakatta/agent*`](https://github.com/MukundaKatta?tab=repositories&q=agent) reliability stack:

- [agentsnap-mcp](https://www.npmjs.com/package/@mukundakatta/agentsnap-mcp), [agentguard-mcp](https://www.npmjs.com/package/@mukundakatta/agentguard-mcp), [agentcast-mcp](https://www.npmjs.com/package/@mukundakatta/agentcast-mcp), [agentfit-mcp](https://www.npmjs.com/package/@mukundakatta/agentfit-mcp), [agentvet-mcp](https://www.npmjs.com/package/@mukundakatta/agentvet-mcp) — and **agentbudget-mcp** (this server)

Direct lib: [`@mukundakatta/agentbudget`](https://www.npmjs.com/package/@mukundakatta/agentbudget) (npm) · [`agentbudget-py`](https://pypi.org/project/agentbudget-py/) (PyPI)

## License

[MIT](LICENSE) © Mukunda Katta
