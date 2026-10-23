import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runMcp } from '../src/mcp.js';
import { fake, tempDir } from './helpers.js';

test('mcp: lists tools and reports key health without ever returning a value', async (t) => {
  const dir = await tempDir();
  const key = fake.anthropic();
  await writeFile(join(dir, '.env'), `ANTHROPIC_API_KEY=${key}\n`);
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  output.on('data', (d) => { text += d; });
  const done = runMcp({ input, output, fetchImpl: async () => ({ status: 401, body: null }) });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'burnkeys_check', arguments: { folder: dir } } }) + '\n');
  input.end();
  await done;
  const msgs = text.trim().split('\n').map((l) => JSON.parse(l));
  t.assert.equal(msgs.find((m) => m.id === 1).result.serverInfo.name, 'burnkeys');
  t.assert.ok(msgs.find((m) => m.id === 2).result.tools.some((x) => x.name === 'burnkeys_status'));
  const r = msgs.find((m) => m.id === 3).result.structuredContent;
  t.assert.equal(r.keys[0].provider, 'Anthropic');
  t.assert.equal(r.keys[0].status, 'dead');
  t.assert.ok(!text.includes(key), 'the key value never appears');
});
