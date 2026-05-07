/**
 * End-to-end smoke test: spawn the MCP server, ask for the tool catalog, then
 * exercise the configure → record → status flow including a cap-trip and a
 * pre-configure record (which should error with a helpful message).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'src', 'server.ts');

let nextId = 1;

function rpc(child: ChildProcess, request: { method: string; params?: object }): Promise<any> {
  const id = nextId++;
  const message = { jsonrpc: '2.0', id, ...request };
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            child.stdout?.off('data', onData);
            resolve(msg);
            return;
          }
        } catch {
          // partial line, keep buffering
        }
      }
    };
    child.stdout?.on('data', onData);
    child.on('error', reject);
    child.stdin?.write(JSON.stringify(message) + '\n');
  });
}

async function withServer<T>(fn: (child: ChildProcess) => Promise<T>): Promise<T> {
  const child = spawn('npx', ['-y', 'tsx', SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Wait for the "ready" line on stderr so we don't race the handshake.
  await new Promise<void>((resolve) => {
    const onErr = (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('ready on stdio')) {
        child.stderr?.off('data', onErr);
        resolve();
      }
    };
    child.stderr?.on('data', onErr);
  });
  // MCP requires an initialize handshake before any other request.
  await rpc(child, {
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'agentbudget-smoke', version: '0.0.0' },
    },
  });
  child.stdin?.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
  );
  try {
    return await fn(child);
  } finally {
    child.kill();
  }
}

test('lists three tools with stable names', async () => {
  await withServer(async (child) => {
    const res = await rpc(child, { method: 'tools/list' });
    const names = res.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(names, ['budget_status', 'configure_budget', 'record_llm_usage']);
  });
});

test('record_llm_usage before configure surfaces a helpful error', async () => {
  await withServer(async (child) => {
    const res = await rpc(child, {
      method: 'tools/call',
      params: {
        name: 'record_llm_usage',
        arguments: { input_tokens: 10, output_tokens: 5 },
      },
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /no active budget/);
  });
});

test('configure → record → status round trip', async () => {
  await withServer(async (child) => {
    const cfg = await rpc(child, {
      method: 'tools/call',
      params: {
        name: 'configure_budget',
        arguments: { max_total_tokens: 100 },
      },
    });
    assert.match(cfg.result.content[0].text, /"ok": true/);

    const rec = await rpc(child, {
      method: 'tools/call',
      params: {
        name: 'record_llm_usage',
        arguments: { input_tokens: 30, output_tokens: 20 },
      },
    });
    const recPayload = JSON.parse(rec.result.content[0].text);
    assert.equal(recPayload.status, 'ok');
    assert.equal(recPayload.totals.total_tokens ?? recPayload.totals.totalTokens, 50);

    const stat = await rpc(child, {
      method: 'tools/call',
      params: { name: 'budget_status', arguments: {} },
    });
    const statPayload = JSON.parse(stat.result.content[0].text);
    assert.equal(statPayload.configured, true);
    assert.equal(
      statPayload.totals.total_tokens ?? statPayload.totals.totalTokens,
      50,
    );
  });
});

test('cap trip returns a structured exceeded payload (not an MCP error)', async () => {
  await withServer(async (child) => {
    await rpc(child, {
      method: 'tools/call',
      params: {
        name: 'configure_budget',
        arguments: { max_total_tokens: 10 },
      },
    });
    const rec = await rpc(child, {
      method: 'tools/call',
      params: {
        name: 'record_llm_usage',
        arguments: { input_tokens: 8, output_tokens: 5 },
      },
    });
    // Not an MCP-level error — the cap trip is data the LLM can read + react to.
    assert.notEqual(rec.result.isError, true);
    const payload = JSON.parse(rec.result.content[0].text);
    assert.equal(payload.status, 'exceeded');
    assert.equal(payload.cap, 'totalTokens');
    assert.equal(payload.attempted, 13);
    assert.equal(payload.limit, 10);
  });
});

test('configure with cost cap + unknown model surfaces UnknownPricingError', async () => {
  await withServer(async (child) => {
    await rpc(child, {
      method: 'tools/call',
      params: {
        name: 'configure_budget',
        arguments: { max_cost_usd: 1 },
      },
    });
    const rec = await rpc(child, {
      method: 'tools/call',
      params: {
        name: 'record_llm_usage',
        arguments: { model: 'mystery-x', input_tokens: 1, output_tokens: 1 },
      },
    });
    assert.equal(rec.result.isError, true);
    assert.match(rec.result.content[0].text, /no pricing entry for model "mystery-x"/);
  });
});
