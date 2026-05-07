#!/usr/bin/env node
/**
 * agentbudget MCP server.
 *
 * Wraps @mukundakatta/agentbudget so any MCP-aware client (Claude Desktop,
 * Cursor, Cline, Windsurf, Zed) can keep a single shared budget across the
 * tools / agents it spawns. The budget lives in this server's process for
 * the duration of the MCP session — start a new session to reset.
 *
 * Three tools:
 *   configure_budget   — set/replace the active caps + pricing
 *   record_llm_usage   — tally one call's tokens; returns updated totals
 *                        (or status:exceeded with the cap that tripped)
 *   budget_status      — peek at current totals + per-cap remaining
 *
 * Configure your client to spawn this binary over stdio. Example for Claude
 * Desktop's `claude_desktop_config.json`:
 *
 *   {
 *     "mcpServers": {
 *       "agentbudget": {
 *         "command": "npx",
 *         "args": ["-y", "@mukundakatta/agentbudget-mcp"]
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  Budget,
  BudgetExceededError,
  UnknownPricingError,
  VERSION,
} from '@mukundakatta/agentbudget';

// One process-wide budget. The MCP session is the natural scope — start a new
// session to start a new run with fresh totals. configure_budget replaces the
// active budget without restarting the server.
let budget: Budget | null = null;

const server = new Server(
  {
    name: 'agentbudget',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// --- tool catalog ---------------------------------------------------------

const PRICING_DESCRIPTION =
  'Optional per-model rate map keyed by model name. Each entry must be ' +
  '{ inputPer1k: number, outputPer1k: number } in dollars per 1,000 tokens. ' +
  'Falls back to the built-in starter table (Claude + GPT) for unknown keys.';

const TOOLS = [
  {
    name: 'configure_budget',
    description:
      'Set the active token + dollar caps for this session. Calling this replaces any existing budget; totals reset to zero. All caps are optional — pass only the ones you want enforced.',
    inputSchema: {
      type: 'object',
      properties: {
        max_input_tokens: {
          type: 'number',
          description: 'Cap on cumulative input tokens across all calls.',
        },
        max_output_tokens: {
          type: 'number',
          description: 'Cap on cumulative output tokens across all calls.',
        },
        max_total_tokens: {
          type: 'number',
          description: 'Cap on input + output combined.',
        },
        max_cost_usd: {
          type: 'number',
          description:
            'Cap on cumulative dollars. Requires per-model pricing — see DEFAULT_PRICING in @mukundakatta/agentbudget or pass `pricing` here.',
        },
        pricing: {
          type: 'object',
          description: PRICING_DESCRIPTION,
          additionalProperties: {
            type: 'object',
            properties: {
              inputPer1k: { type: 'number' },
              outputPer1k: { type: 'number' },
            },
            required: ['inputPer1k', 'outputPer1k'],
          },
        },
        allow_unknown_pricing: {
          type: 'boolean',
          description:
            'When true, models with no pricing entry cost $0 instead of erroring. Only honored when max_cost_usd is set.',
        },
      },
    },
  },
  {
    name: 'record_llm_usage',
    description:
      'Tally one LLM call against the active budget. Call after the response — by the time you have token counts, the call already cost money. Returns the updated totals on success, or { status: "exceeded", cap, limit, attempted } when a cap was hit. The exceeded payload still reflects the call (totals are updated even when a cap trips, mirroring real provider behavior).',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Model name; required when a max_cost_usd cap is active.',
        },
        input_tokens: {
          type: 'number',
          description: 'Input/prompt tokens reported by the provider.',
        },
        output_tokens: {
          type: 'number',
          description: 'Output/completion tokens reported by the provider.',
        },
      },
      required: ['input_tokens', 'output_tokens'],
    },
  },
  {
    name: 'budget_status',
    description:
      'Return the current totals + per-cap remaining for the active budget. Useful for letting an agent decide whether to schedule more work.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// --- tool dispatch --------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case 'configure_budget':
        return configureBudgetTool(args as unknown as ConfigureInput);
      case 'record_llm_usage':
        return recordUsageTool(args as unknown as RecordUsageInput);
      case 'budget_status':
        return budgetStatusTool();
      default:
        return errorResult('unknown tool: ' + name);
    }
  } catch (err) {
    return errorResult('internal error: ' + (err as Error).message);
  }
});

// --- tool implementations -------------------------------------------------

interface ConfigureInput {
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_total_tokens?: number;
  max_cost_usd?: number;
  pricing?: Record<string, { inputPer1k: number; outputPer1k: number }>;
  allow_unknown_pricing?: boolean;
}

function configureBudgetTool(input: ConfigureInput) {
  budget = new Budget({
    maxInputTokens: input.max_input_tokens,
    maxOutputTokens: input.max_output_tokens,
    maxTotalTokens: input.max_total_tokens,
    maxCostUsd: input.max_cost_usd,
    pricing: input.pricing,
    allowUnknownPricing: input.allow_unknown_pricing,
  });
  return jsonResult({
    ok: true,
    caps: budget.caps,
    pricing_keys: Object.keys(input.pricing ?? {}),
    allow_unknown_pricing: Boolean(input.allow_unknown_pricing),
  });
}

interface RecordUsageInput {
  model?: string;
  input_tokens: number;
  output_tokens: number;
}

function recordUsageTool(input: RecordUsageInput) {
  if (!budget) {
    return errorResult(
      'no active budget — call configure_budget first to set the caps for this session',
    );
  }
  try {
    const totals = budget.recordUsage({
      model: input.model,
      inputTokens: Number(input.input_tokens),
      outputTokens: Number(input.output_tokens),
    });
    return jsonResult({ status: 'ok', totals, remaining: budget.remaining() });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      // Surface as a structured payload — not an MCP error — so the LLM can
      // read it and decide what to do (e.g. fall back, summarize, stop).
      return jsonResult({
        status: 'exceeded',
        cap: err.cap,
        limit: err.limit,
        attempted: err.attempted,
        overshoot: err.overshoot,
        model: err.model,
        totals: budget.totals,
      });
    }
    if (err instanceof UnknownPricingError) {
      return errorResult(
        `no pricing entry for model "${err.model}". Add it via configure_budget.pricing, or set allow_unknown_pricing=true to charge $0 for unknown models.`,
      );
    }
    throw err;
  }
}

function budgetStatusTool() {
  if (!budget) {
    return jsonResult({
      configured: false,
      hint: 'call configure_budget to set caps for this session',
    });
  }
  return jsonResult({
    configured: true,
    caps: budget.caps,
    totals: budget.totals,
    remaining: budget.remaining(),
  });
}

// --- helpers --------------------------------------------------------------

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

// --- bootstrap ------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(
  `agentbudget MCP server v0.1.0 (agentbudget ${VERSION}) ready on stdio\n`,
);
