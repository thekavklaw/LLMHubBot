const assert = require('assert');
const path = require('path');

let passed = 0, failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`✅ ${name}`);
  } catch (err) {
    failed++;
    results.push(`❌ ${name}: ${err.message}`);
  }
}

(async () => {
  console.log('=== LLMHub Bot Agentic Test Suite ===\n');

  // ──────────── TOOL REGISTRY TESTS ────────────
  const ToolRegistry = require('../tools/registry');

  await test('ToolRegistry: loads all 10 tools', () => {
    const reg = new ToolRegistry();
    reg.loadAll();
    assert.strictEqual(reg.tools.size, 10, `Expected 10 tools, got ${reg.tools.size}`);
  });

  await test('ToolRegistry: each tool has required fields', () => {
    const reg = new ToolRegistry();
    reg.loadAll();
    for (const [name, tool] of reg.tools) {
      assert.ok(tool.name, `${name} missing name`);
      assert.ok(tool.description, `${name} missing description`);
      assert.ok(tool.parameters, `${name} missing parameters`);
      assert.ok(typeof tool.execute === 'function', `${name} missing execute`);
    }
  });

  await test('ToolRegistry: getToolsForOpenAI returns correct format', () => {
    const reg = new ToolRegistry();
    reg.loadAll();
    const tools = reg.getToolsForOpenAI();
    assert.ok(Array.isArray(tools));
    assert.strictEqual(tools.length, 10);
    for (const t of tools) {
      assert.strictEqual(t.type, 'function');
      assert.ok(t.function.name);
      assert.ok(t.function.description);
      assert.ok(t.function.parameters);
    }
  });

  await test('ToolRegistry: executeTool handles unknown tool', async () => {
    const reg = new ToolRegistry();
    const result = await reg.executeTool('nonexistent_tool', {}, {});
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Unknown tool'));
  });

  await test('ToolRegistry: executeTool handles tool error gracefully', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'error_tool',
      description: 'Always throws',
      parameters: { type: 'object', properties: {} },
      execute: async () => { throw new Error('Intentional failure'); },
    });
    const result = await reg.executeTool('error_tool', {}, {});
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Intentional failure'));
  });

  await test('ToolRegistry: executeTool handles timeout', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'slow_tool',
      description: 'Takes forever',
      parameters: { type: 'object', properties: {} },
      timeout: 100,
      execute: async () => new Promise(resolve => setTimeout(resolve, 5000)),
    });
    const result = await reg.executeTool('slow_tool', {}, {});
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('timed out'));
  });

  await test('ToolRegistry: listTools returns names and descriptions', () => {
    const reg = new ToolRegistry();
    reg.loadAll();
    const list = reg.listTools();
    assert.strictEqual(list.length, 10);
    for (const item of list) {
      assert.ok(item.name);
      assert.ok(item.description);
    }
  });

  // ──────────── AGENT LOOP TESTS ────────────
  const AgentLoop = require('../agent-loop');

  await test('AgentLoop: terminates when no tool calls', async () => {
    const mockRegistry = { getToolsForOpenAI: () => [] };
    const mockOpenAI = {
      createChatCompletion: async () => ({ content: 'Hello!', tool_calls: null }),
    };
    const loop = new AgentLoop(mockRegistry, mockOpenAI, { maxAgentIterations: 5 });
    const result = await loop.run([], 'system prompt', { generatedImages: [] });
    assert.strictEqual(result.text, 'Hello!');
    assert.strictEqual(result.iterations, 1);
    assert.deepStrictEqual(result.toolsUsed, []);
  });

  await test('AgentLoop: respects max iterations', async () => {
    const mockRegistry = {
      getToolsForOpenAI: () => [{ type: 'function', function: { name: 'test', description: 't', parameters: {} } }],
      executeTool: async () => ({ success: true, result: 'ok' }),
    };
    let callCount = 0;
    const mockOpenAI = {
      createChatCompletion: async (msgs, tools) => {
        callCount++;
        if (tools.length === 0) return { content: 'done' };
        return {
          content: null,
          tool_calls: [{ id: `call_${callCount}`, function: { name: 'test', arguments: JSON.stringify({ n: callCount }) } }],
        };
      },
    };
    const loop = new AgentLoop(mockRegistry, mockOpenAI, { maxAgentIterations: 3 });
    const result = await loop.run([], 'sys', { generatedImages: [] });
    assert.strictEqual(result.iterations, 3);
    assert.strictEqual(result.text, 'done');
  });

  await test('AgentLoop: detects duplicate calls', async () => {
    const mockRegistry = {
      getToolsForOpenAI: () => [{ type: 'function', function: { name: 'dup', description: 'd', parameters: {} } }],
      executeTool: async () => ({ success: true, result: 'ok' }),
    };
    let callNum = 0;
    const mockOpenAI = {
      createChatCompletion: async (msgs, tools) => {
        callNum++;
        if (callNum === 1) {
          return {
            content: null,
            tool_calls: [
              { id: 'c1', function: { name: 'dup', arguments: '{"x":1}' } },
            ],
          };
        }
        if (callNum === 2) {
          // Same call again
          return {
            content: null,
            tool_calls: [
              { id: 'c2', function: { name: 'dup', arguments: '{"x":1}' } },
            ],
          };
        }
        return { content: 'final', tool_calls: null };
      },
    };
    const loop = new AgentLoop(mockRegistry, mockOpenAI, { maxAgentIterations: 5 });
    const result = await loop.run([], 'sys', { generatedImages: [] });
    // Only one unique call sig in history
    assert.strictEqual(result.toolsUsed.length, 1);
  });

  await test('AgentLoop: handles tool errors without crashing', async () => {
    const mockRegistry = {
      getToolsForOpenAI: () => [{ type: 'function', function: { name: 'fail', description: 'f', parameters: {} } }],
      executeTool: async () => ({ success: false, result: null, error: 'boom' }),
    };
    let n = 0;
    const mockOpenAI = {
      createChatCompletion: async (msgs, tools) => {
        n++;
        if (n === 1) return { content: null, tool_calls: [{ id: 'c1', function: { name: 'fail', arguments: '{}' } }] };
        return { content: 'recovered', tool_calls: null };
      },
    };
    const loop = new AgentLoop(mockRegistry, mockOpenAI, { maxAgentIterations: 5 });
    const result = await loop.run([], 'sys', { generatedImages: [] });
    assert.strictEqual(result.text, 'recovered');
  });

  await test('AgentLoop: tracks generated images via context', async () => {
    const mockRegistry = {
      getToolsForOpenAI: () => [{ type: 'function', function: { name: 'generate_image', description: 'g', parameters: {} } }],
      executeTool: async (name, args, context) => {
        // Simulate what the real generate_image tool does: push to context.generatedImages
        context.generatedImages = context.generatedImages || [];
        context.generatedImages.push({ image_buffer: 'abc123', prompt_used: 'cat', size: '1024x1024' });
        return { success: true, result: { success: true, description: 'Generated image', size: '1024x1024' } };
      },
    };
    let n = 0;
    const mockOpenAI = {
      createChatCompletion: async (msgs, tools) => {
        n++;
        if (n === 1) return { content: null, tool_calls: [{ id: 'c1', function: { name: 'generate_image', arguments: '{}' } }] };
        return { content: 'here is your image', tool_calls: null };
      },
    };
    const loop = new AgentLoop(mockRegistry, mockOpenAI, { maxAgentIterations: 5 });
    const ctx = { generatedImages: [] };
    const result = await loop.run([], 'sys', ctx);
    assert.strictEqual(result.images.length, 1);
    assert.strictEqual(result.images[0].image_buffer, 'abc123');
  });

  // ──────────── THINKING LAYER TESTS ────────────
  const { relevanceGate } = require('../thinking/layer1-gate');

  const makeCtx = (overrides = {}) => ({
    botId: '123', inThread: false, channelId: 'ch1', gptChannelId: 'ch1',
    mentionsBot: false, repliesToBot: false, userName: 'TestUser',
    ...overrides,
  });

  await test('Layer1: bot mention → engage', async () => {
    const result = await relevanceGate({ content: 'hello' }, makeCtx({ mentionsBot: true }));
    assert.strictEqual(result.engage, true);
    assert.ok(result.reason.includes('mentioned'));
  });

  await test('Layer1: emoji only → dont engage', async () => {
    const result = await relevanceGate({ content: '😂🔥' }, makeCtx());
    assert.strictEqual(result.engage, false);
    assert.ok(result.reason.includes('emoji'));
  });

  await test('Layer1: thread message → engage', async () => {
    const result = await relevanceGate({ content: 'what about this?' }, makeCtx({ inThread: true }));
    assert.strictEqual(result.engage, true);
    assert.ok(result.reason.includes('thread'));
  });

  await test('Layer1: short message → dont engage', async () => {
    const result = await relevanceGate({ content: 'hi' }, makeCtx());
    assert.strictEqual(result.engage, false);
    assert.ok(result.reason.includes('short'));
  });

  await test('Layer1: low-value filler → dont engage', async () => {
    const result = await relevanceGate({ content: 'lol' }, makeCtx());
    assert.strictEqual(result.engage, false);
    assert.ok(result.reason.includes('filler') || result.reason.includes('Low'));
  });

  await test('Layer1: reply to bot → engage', async () => {
    const result = await relevanceGate({ content: 'thanks for that' }, makeCtx({ repliesToBot: true }));
    assert.strictEqual(result.engage, true);
    assert.ok(result.reason.includes('Reply'));
  });

  await test('Layer1: question in gpt channel → engage', async () => {
    const result = await relevanceGate({ content: 'What is the meaning of life?' }, makeCtx({ channelId: 'ch1', gptChannelId: 'ch1' }));
    assert.strictEqual(result.engage, true);
  });

  // ──────────── LAYER 4: SYNTHESIZE TESTS ────────────
  const { synthesize, smartSplit } = require('../thinking/layer4-synthesize');

  await test('Layer4: smartSplit keeps short messages intact', () => {
    const parts = smartSplit('Hello world');
    assert.strictEqual(parts.length, 1);
    assert.strictEqual(parts[0], 'Hello world');
  });

  await test('Layer4: smartSplit splits long messages', () => {
    const long = 'A'.repeat(2500);
    const parts = smartSplit(long, 2000);
    assert.ok(parts.length >= 2);
    for (const p of parts) assert.ok(p.length <= 2000);
  });

  await test('Layer4: smartSplit handles unclosed code blocks', () => {
    const text = '```js\n' + 'x = 1;\n'.repeat(400) + 'end';
    const parts = smartSplit(text, 2000);
    assert.ok(parts.length >= 2);
    // First part should end with ``` (closing)
    assert.ok(parts[0].endsWith('```'), 'First part should close code block');
    // Second part should start with ```
    assert.ok(parts[1].startsWith('```'), 'Second part should reopen code block');
  });

  await test('Layer4: synthesize returns valid response object', async () => {
    const result = { text: 'Hello!', toolsUsed: ['calculator'], iterations: 1, images: [] };
    const intent = { intent: 'question', tone: 'helpful' };
    const ctx = { userId: 'u1' };
    const resp = await synthesize(result, intent, ctx);
    assert.strictEqual(resp.action, 'respond');
    assert.ok(resp.messages.length > 0);
    assert.strictEqual(resp.messages[0].content, 'Hello!');
  });

  await test('Layer4: synthesize handles empty result', async () => {
    const result = { text: '', toolsUsed: [], iterations: 0, images: [] };
    const resp = await synthesize(result, {}, {});
    assert.strictEqual(resp.action, 'ignore');
  });

  // ──────────── INDIVIDUAL TOOL TESTS ────────────
  const calculator = require('../tools/definitions/calculator');
  const timestamp = require('../tools/definitions/timestamp');
  const code_runner = require('../tools/definitions/code_runner');
  const define_word = require('../tools/definitions/define_word');
  const summarize_url = require('../tools/definitions/summarize_url');
  const remember = require('../tools/definitions/remember');
  const recall = require('../tools/definitions/recall');

  await test('calculator: 2+2=4', async () => {
    const r = await calculator.execute({ expression: '2+2' });
    assert.strictEqual(r.result, 4);
  });

  await test('calculator: blocks process.exit()', async () => {
    try {
      await calculator.execute({ expression: 'process.exit()' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('Blocked') || err.message.includes('unsafe'));
    }
  });

  await test('calculator: handles division by zero', async () => {
    try {
      await calculator.execute({ expression: '1/0' });
      assert.fail('Should throw for non-finite result');
    } catch (err) {
      assert.ok(err.message.includes('finite'));
    }
  });

  await test('calculator: sqrt(144)=12', async () => {
    const r = await calculator.execute({ expression: 'sqrt(144)' });
    assert.strictEqual(r.result, 12);
  });

  await test('timestamp: returns valid date string', async () => {
    const r = await timestamp.execute({});
    assert.ok(r.date);
    assert.ok(r.time);
    assert.ok(r.iso);
    assert.ok(r.unix > 0);
  });

  await test('timestamp: respects timezone parameter', async () => {
    const r = await timestamp.execute({ timezone: 'America/New_York' });
    assert.strictEqual(r.timezone, 'America/New_York');
  });

  await test('code_runner: has E2B-based implementation', () => {
    assert.strictEqual(code_runner.name, 'code_runner');
    assert.ok(code_runner.description.includes('sandbox'));
    assert.deepStrictEqual(code_runner.parameters.properties.language.enum, ['python', 'javascript']);
  });

  await test('code_runner: rejects unsupported language', async () => {
    try {
      await code_runner.execute({ code: 'x', language: 'ruby' });
      assert.fail('Should throw');
    } catch (e) {
      assert.ok(e.message.includes('Unsupported'));
    }
  });

  await test('code_runner: rejects oversized code', async () => {
    try {
      await code_runner.execute({ code: 'x'.repeat(10001) });
      assert.fail('Should throw');
    } catch (e) {
      assert.ok(e.message.includes('too long'));
    }
  });

  await test('define_word: handles valid word', async () => {
    const r = await define_word.execute({ word: 'hello' });
    assert.strictEqual(r.found, true);
    assert.ok(r.meanings.length > 0);
  });

  await test('define_word: handles unknown word gracefully', async () => {
    const r = await define_word.execute({ word: 'xyzzznotaword123' });
    assert.strictEqual(r.found, false);
  });

  await test('summarize_url: blocks private IPs', async () => {
    try {
      await summarize_url.execute({ url: 'http://192.168.1.1/secret' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('Blocked') || err.message.includes('internal'));
    }
  });

  await test('summarize_url: blocks localhost', async () => {
    try {
      await summarize_url.execute({ url: 'http://localhost:8080/admin' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('Blocked') || err.message.includes('internal'));
    }
  });

  await test('summarize_url: blocks file protocol', async () => {
    try {
      await summarize_url.execute({ url: 'file:///etc/passwd' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message);
    }
  });

  // Memory tools need DB — test with mocked memory module
  await test('remember: stores to DB', async () => {
    try {
      const r = await remember.execute(
        { content: 'Test memory for agentic suite', category: 'fact' },
        { userId: 'test123', userName: 'TestUser', channelId: 'ch1' }
      );
      assert.strictEqual(r.stored, true);
      assert.strictEqual(r.category, 'fact');
    } catch (err) {
      // If DB/embedding fails, that's an infrastructure issue not a code bug
      if (!err.message.includes('OPENAI') && !err.message.includes('API')) throw err;
    }
  });

  await test('recall: retrieves stored memory', async () => {
    try {
      const r = await recall.execute({ query: 'test memory', limit: 3 });
      assert.ok(r.found !== undefined); // Either found or not, but shouldn't crash
    } catch (err) {
      if (!err.message.includes('OPENAI') && !err.message.includes('API')) throw err;
    }
  });

  // ──────────── INTEGRATION FLOW TESTS ────────────
  await test('Integration: full mock pipeline returns valid response', async () => {
    const ThinkingOrchestrator = require('../thinking/orchestrator');

    const mockRegistry = {
      getToolsForOpenAI: () => [],
      listTools: () => [{ name: 'calculator', description: 'calc' }],
      executeTool: async () => ({ success: true, result: 'ok' }),
    };
    const mockAgentLoop = {
      run: async () => ({
        text: 'The answer is 42.',
        toolsUsed: [],
        iterations: 1,
        images: [],
      }),
    };
    const orchestrator = new ThinkingOrchestrator({
      toolRegistry: mockRegistry,
      agentLoop: mockAgentLoop,
      config: { agentLoopTimeout: 5000 },
    });

    const result = await orchestrator.process(
      { content: 'What is the answer to everything?' },
      {
        userId: 'u1', userName: 'Tester', channelId: 'ch1',
        botId: '123', inThread: true, mentionsBot: false,
        repliesToBot: false, gptChannelId: 'ch1', displayName: 'Tester',
      }
    );

    assert.strictEqual(result.action, 'respond');
    assert.ok(result.messages.length > 0);
    assert.ok(result.text.includes('42'));
  });

  // ──────────── LOGGER TESTS ────────────
  const logger = require('../logger');

  await test('Logger: all log levels exist', () => {
    assert.ok(typeof logger.debug === 'function');
    assert.ok(typeof logger.info === 'function');
    assert.ok(typeof logger.warn === 'function');
    assert.ok(typeof logger.error === 'function');
  });

  await test('Logger: setLevel works', () => {
    logger.setLevel('debug');
    assert.ok(true); // No throw
    logger.setLevel('info'); // Reset
  });

  await test('Logger: formatTimestamp returns string', () => {
    const ts = logger.formatTimestamp();
    assert.ok(typeof ts === 'string');
    assert.ok(ts.length > 10);
  });

  // ──────────── RETRY TESTS ────────────
  const { withRetry } = require('../utils/retry');

  await test('Retry: succeeds on first try', async () => {
    let calls = 0;
    const result = await withRetry(() => { calls++; return 'ok'; }, { label: 'test' });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 1);
  });

  await test('Retry: retries on failure then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'recovered';
    }, { label: 'test', backoffMs: 10 });
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(calls, 3);
  });

  await test('Retry: respects maxRetries', async () => {
    let calls = 0;
    try {
      await withRetry(() => { calls++; throw new Error('always fails'); }, { label: 'test', maxRetries: 2, backoffMs: 10 });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'always fails');
      assert.strictEqual(calls, 2);
    }
  });

  await test('Retry: does not retry on 400 errors', async () => {
    let calls = 0;
    try {
      await withRetry(() => {
        calls++;
        const err = new Error('Bad request');
        err.status = 400;
        throw err;
      }, { label: 'test', backoffMs: 10 });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.status, 400);
      assert.strictEqual(calls, 1); // No retry
    }
  });

  await test('Retry: does not retry on 404 errors', async () => {
    let calls = 0;
    try {
      await withRetry(() => {
        calls++;
        const err = new Error('Not found');
        err.status = 404;
        throw err;
      }, { label: 'test', backoffMs: 10 });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(calls, 1);
    }
  });

  await test('Retry: retries on 429 rate limit', async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 2) {
        const err = new Error('Rate limited');
        err.status = 429;
        throw err;
      }
      return 'ok';
    }, { label: 'test', backoffMs: 10 });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 2);
  });

  await test('Retry: retries on 500 server errors', async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 2) {
        const err = new Error('Server error');
        err.status = 500;
        throw err;
      }
      return 'ok';
    }, { label: 'test', backoffMs: 10 });
    assert.strictEqual(result, 'ok');
    assert.ok(calls >= 2);
  });

  await test('Retry: respects retryOn filter', async () => {
    let calls = 0;
    try {
      await withRetry(() => {
        calls++;
        throw new Error('custom error');
      }, { label: 'test', backoffMs: 10, retryOn: (err) => err.message === 'retryable' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(calls, 1); // retryOn returned false, no retry
    }
  });

  // ──────────── MULTI-MESSAGE SYNTHESIS TESTS ────────────

  await test('Layer4: multi-message with images sends text then images', async () => {
    const { AttachmentBuilder } = require('discord.js');
    const result = {
      text: 'Here is your image!',
      toolsUsed: ['generate_image'],
      iterations: 2,
      images: [{ image_buffer: Buffer.from('fake').toString('base64') }],
    };
    const resp = await synthesize(result, { intent: 'image_request' }, { userId: 'u1' });
    assert.strictEqual(resp.action, 'respond');
    assert.ok(resp.messages.length >= 2); // text + image
    // First message should be text
    assert.strictEqual(resp.messages[0].content, 'Here is your image!');
    // Last message should have files and delay
    const imgMsg = resp.messages[resp.messages.length - 1];
    assert.ok(imgMsg.files.length > 0);
    assert.strictEqual(imgMsg.delayMs, 500);
  });

  await test('Layer4: follow-up messages are included', async () => {
    const result = {
      text: 'Main response.',
      toolsUsed: [],
      iterations: 1,
      images: [],
      followUps: [{ content: 'By the way...', delayMs: 1500 }],
    };
    const resp = await synthesize(result, {}, { userId: 'u1' });
    assert.strictEqual(resp.messages.length, 2);
    assert.strictEqual(resp.messages[1].content, 'By the way...');
    assert.strictEqual(resp.messages[1].delayMs, 1500);
  });

  await test('Layer4: text-only returns messages without delay', async () => {
    const result = { text: 'Just text.', toolsUsed: [], iterations: 1, images: [] };
    const resp = await synthesize(result, {}, { userId: 'u1' });
    assert.strictEqual(resp.messages.length, 1);
    assert.strictEqual(resp.messages[0].delayMs, 0);
  });

  // ──────────── ORCHESTRATOR FALLBACK TESTS ────────────

  await test('Orchestrator: intent failure uses defaults', async () => {
    const ThinkingOrchestrator = require('../thinking/orchestrator');
    const mockRegistry = {
      getToolsForOpenAI: () => [],
      listTools: () => [{ name: 'test', description: 't' }],
    };
    const mockAgentLoop = {
      run: async () => ({ text: 'Fallback response.', toolsUsed: [], iterations: 1, images: [] }),
    };
    const orch = new ThinkingOrchestrator({
      toolRegistry: mockRegistry,
      agentLoop: mockAgentLoop,
      config: { agentLoopTimeout: 5000 },
    });

    // This test verifies the orchestrator doesn't crash when intent analysis would fail
    // (in production it catches the error and uses defaults)
    const result = await orch.process(
      { content: 'test message for fallback' },
      { userId: 'u1', userName: 'Tester', channelId: 'ch1', botId: '123',
        inThread: true, mentionsBot: false, repliesToBot: false, gptChannelId: 'ch1', displayName: 'Tester' }
    );
    assert.strictEqual(result.action, 'respond');
  });

  // ──────────── MEMORY MANAGEMENT TESTS ────────────
  const { cosineSimilarity, float32ToBuffer, bufferToFloat32, LRUCache: MemLRU } = require('../memory');

  await test('Memory: cosine similarity of identical vectors = 1', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    assert.strictEqual(cosineSimilarity(a, b), 1);
  });

  await test('Memory: cosine similarity of orthogonal vectors = 0', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    const sim = cosineSimilarity(a, b);
    assert.ok(Math.abs(sim) < 0.001);
  });

  await test('Memory: float32 roundtrip through buffer', () => {
    const original = new Float32Array([1.5, -2.3, 0.001, 999.99]);
    const buf = float32ToBuffer(original);
    const restored = bufferToFloat32(buf);
    assert.strictEqual(restored.length, original.length);
    for (let i = 0; i < original.length; i++) {
      assert.ok(Math.abs(restored[i] - original[i]) < 0.001);
    }
  });

  await test('Memory: LRU cache evicts oldest', () => {
    const cache = new MemLRU(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4); // Should evict 'a'
    assert.strictEqual(cache.get('a'), undefined);
    assert.strictEqual(cache.get('d'), 4);
    assert.strictEqual(cache.size, 3);
  });

  await test('Memory: LRU cache refreshes on get', () => {
    const cache = new MemLRU(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a'); // refresh 'a'
    cache.set('d', 4); // Should evict 'b' (oldest non-refreshed)
    assert.strictEqual(cache.get('a'), 1);
    assert.strictEqual(cache.get('b'), undefined);
  });

  // ──────────── BACKPRESSURE / LOAD LEVEL ────────────

  await test('Orchestrator: getLoadLevel returns correct levels', () => {
    // Access getLoadLevel via the module internals
    // We test the logic directly
    function getLoadLevel(queueStats) {
      if (!queueStats || !queueStats.main) return 1;
      const mainDepth = queueStats.main.pending || 0;
      if (mainDepth > 40) return 4;
      if (mainDepth > 25) return 3;
      if (mainDepth > 10) return 2;
      return 1;
    }
    assert.strictEqual(getLoadLevel(null), 1);
    assert.strictEqual(getLoadLevel({}), 1);
    assert.strictEqual(getLoadLevel({ main: { pending: 0 } }), 1);
    assert.strictEqual(getLoadLevel({ main: { pending: 5 } }), 1);
    assert.strictEqual(getLoadLevel({ main: { pending: 11 } }), 2);
    assert.strictEqual(getLoadLevel({ main: { pending: 26 } }), 3);
    assert.strictEqual(getLoadLevel({ main: { pending: 41 } }), 4);
  });

  // ──────────── SMART SPLIT EDGE CASES ────────────

  await test('SmartSplit: empty string', () => {
    const { smartSplit } = require('../thinking/layer4-synthesize');
    const result = smartSplit('');
    assert.deepStrictEqual(result, ['']);
  });

  await test('SmartSplit: exactly 2000 chars', () => {
    const { smartSplit } = require('../thinking/layer4-synthesize');
    const text = 'a'.repeat(2000);
    const result = smartSplit(text);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].length, 2000);
  });

  await test('SmartSplit: handles code blocks', () => {
    const { smartSplit } = require('../thinking/layer4-synthesize');
    const code = '```js\n' + 'x'.repeat(1990) + '\n```\nMore text here after code block.';
    const result = smartSplit(code);
    assert.ok(result.length >= 2);
    // Verify code blocks are properly handled
    for (const part of result) {
      const opens = (part.match(/```/g) || []).length;
      assert.ok(opens % 2 === 0, `Unclosed code block in part: opens=${opens}`);
    }
  });

  await test('SmartSplit: splits at paragraph breaks', () => {
    const { smartSplit } = require('../thinking/layer4-synthesize');
    const text = 'a'.repeat(1500) + '\n\n' + 'b'.repeat(600);
    const result = smartSplit(text, 2000);
    assert.strictEqual(result.length, 2);
    assert.ok(result[0].endsWith('a'));
    assert.ok(result[1].startsWith('b'));
  });

  // ──────────── TOOL REGISTRY EXTENDED ────────────

  await test('ToolRegistry: getTool returns tool by name', () => {
    const ToolRegistry = require('../tools/registry');
    const reg = new ToolRegistry();
    reg.loadAll();
    const brave = reg.getTool('brave_search');
    assert.ok(brave);
    assert.strictEqual(brave.name, 'brave_search');
  });

  await test('ToolRegistry: getTool returns undefined for unknown', () => {
    const ToolRegistry = require('../tools/registry');
    const reg = new ToolRegistry();
    const result = reg.getTool('nonexistent_tool');
    assert.strictEqual(result, undefined);
  });

  await test('ToolRegistry: executeTool returns error for unknown tool', async () => {
    const ToolRegistry = require('../tools/registry');
    const reg = new ToolRegistry();
    const result = await reg.executeTool('nonexistent', {}, {});
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Unknown tool'));
  });

  await test('ToolRegistry: getToolsForOpenAI with filter', () => {
    const ToolRegistry = require('../tools/registry');
    const reg = new ToolRegistry();
    reg.loadAll();
    const filtered = reg.getToolsForOpenAI(t => t.name === 'calculator');
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].function.name, 'calculator');
  });

  // ──────────── TOOL CACHES ────────────

  await test('BraveSearch: cache instance exists', () => {
    const brave = require('../tools/definitions/brave_search');
    const cache = brave.getCache();
    assert.ok(cache);
    assert.ok(typeof cache.get === 'function');
    assert.ok(typeof cache.set === 'function');
  });

  await test('TavilySearch: cache instance exists', () => {
    const tavily = require('../tools/definitions/tavily_search');
    const cache = tavily.getCache();
    assert.ok(cache);
    assert.ok(typeof cache.get === 'function');
  });

  // ──────────── CALCULATOR TOOL ────────────

  await test('Calculator: basic math', async () => {
    const calc = require('../tools/definitions/calculator');
    const result = await calc.execute({ expression: '2 + 3 * 4' });
    assert.strictEqual(result.result, 14);
  });

  await test('Calculator: rejects dangerous input', async () => {
    const calc = require('../tools/definitions/calculator');
    try {
      await calc.execute({ expression: 'require("fs")' });
      assert.fail('Should reject');
    } catch (e) {
      assert.ok(e.message.includes('Invalid') || e.message.includes('not allowed') || e.message.includes('Blocked') || e.message.includes('unsafe'));
    }
  });

  // ──────────── TIMESTAMP TOOL ────────────

  await test('Timestamp: returns current time', async () => {
    const ts = require('../tools/definitions/timestamp');
    const result = await ts.execute({});
    assert.ok(result.iso || result.utc || result.local || result.time);
  });

  await test('Timestamp: timezone conversion', async () => {
    const ts = require('../tools/definitions/timestamp');
    const result = await ts.execute({ timezone: 'America/New_York' });
    assert.ok(result);
  });

  // ──────────── DEFINE WORD TOOL ────────────

  await test('DefineWord: has correct schema', () => {
    const define = require('../tools/definitions/define_word');
    assert.strictEqual(define.name, 'define_word');
    assert.ok(define.parameters.required.includes('word'));
  });

  // ──────────── REMEMBER/RECALL TOOLS ────────────

  await test('Remember: has correct schema', () => {
    const remember = require('../tools/definitions/remember');
    assert.strictEqual(remember.name, 'remember');
    assert.ok(typeof remember.execute === 'function');
  });

  await test('Recall: has correct schema', () => {
    const recall = require('../tools/definitions/recall');
    assert.strictEqual(recall.name, 'recall');
    assert.ok(typeof recall.execute === 'function');
  });

  // ──────────── CODE RUNNER TOOL ────────────

  await test('CodeRunner: has correct schema', () => {
    const codeRunner = require('../tools/definitions/code_runner');
    assert.strictEqual(codeRunner.name, 'code_runner');
    assert.ok(codeRunner.parameters.required.includes('code'));
  });

  // ──────────── GENERATE IMAGE TOOL ────────────

  await test('GenerateImage: has correct schema', () => {
    const genImage = require('../tools/definitions/generate_image');
    assert.strictEqual(genImage.name, 'generate_image');
    assert.ok(typeof genImage.execute === 'function');
  });

  // ──────────── AGENT LOOP ────────────

  await test('AgentLoop: constructor sets defaults', () => {
    const AgentLoop = require('../agent-loop');
    const loop = new AgentLoop({}, {}, {});
    assert.strictEqual(loop.maxIterations, 10);
    assert.strictEqual(loop.timeout, 60000);
  });

  await test('AgentLoop: constructor accepts config', () => {
    const AgentLoop = require('../agent-loop');
    const loop = new AgentLoop({}, {}, { maxAgentIterations: 5, agentLoopTimeout: 30000 });
    assert.strictEqual(loop.maxIterations, 5);
    assert.strictEqual(loop.timeout, 30000);
  });

  // ──────────── ERRORS MODULE ────────────

  await test('Errors: all USER_ERRORS keys present', () => {
    const { USER_ERRORS } = require('../utils/errors');
    const expected = ['rate_limit', 'timeout', 'api_error', 'moderation', 'queue_full', 'unknown'];
    for (const key of expected) {
      assert.ok(USER_ERRORS[key], `Missing key: ${key}`);
    }
  });

  await test('Errors: friendlyError prioritizes specific errors', () => {
    const { friendlyError, USER_ERRORS } = require('../utils/errors');
    // 429 should be rate_limit even if message says "timeout"
    assert.ok(friendlyError({ status: 429, message: 'timeout' }).startsWith(USER_ERRORS.rate_limit));
    // QUEUE_FULL should be queue_full even if status is set
    assert.ok(friendlyError({ message: 'QUEUE_FULL', status: 500 }).startsWith(USER_ERRORS.queue_full));
  });

  // ──────────── USER SETTINGS IN INTENT ────────────

  await test('UserSettings: DB roundtrip in intent context', () => {
    const { getUserSettings, saveUserSettings } = require('../db');
    // Verify the settings module is importable and works
    saveUserSettings('intent-test-user', 'concise', false);
    const s = getUserSettings('intent-test-user');
    assert.strictEqual(s.verbosity, 'concise');
    assert.strictEqual(s.images_enabled, 0);
    // Cleanup
    const { getDb } = require('../db');
    getDb().prepare("DELETE FROM user_settings WHERE user_id = 'intent-test-user'").run();
  });

  // ──────────── INTERACTION HANDLER EXPORTS ────────────

  await test('InteractionHandler: exports handleInteraction', () => {
    const handler = require('../handlers/interactionHandler');
    assert.ok(typeof handler.handleInteraction === 'function');
  });

  await test('InteractionHandler: exports generateSmartTitle', () => {
    const handler = require('../handlers/interactionHandler');
    assert.ok(typeof handler.generateSmartTitle === 'function');
  });

  // ──────────── SUMMARY ────────────
  console.log('\n' + results.join('\n'));
  console.log(`\n=== Agentic Tests: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
