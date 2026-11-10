/**
 * 纯逻辑单元测试 —— 不依赖酒馆环境。
 * 用 node 直接跑: node test-logic.mjs
 *
 * 覆盖:
 * - 模型 id 归一化
 * - 价格查找与默认价兜底
 * - 费用计算(含缓存)
 * - SSE usage 多格式解析
 */

import assert from 'node:assert/strict';
import {
    normalizeModelId, modelCandidates, findPrice, computeCost,
    buildRecord, summarize, isUsablePrice, normalizePrice,
} from './lib/pricing.js';
import {
    parseSseLine, parseSseText, parseUsageFromBody, normalizeUsage,
    isGenerateUrl, extractModelFromInit, mergeUsage,
} from './lib/usage.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`      ${e.message.split('\n')[0]}`);
    }
}

console.log('=== 模型 id 归一化 ===');

test('裸名保持不变', () => {
    assert.equal(normalizeModelId('claude-sonnet-5'), 'claude-sonnet-5');
});

test('剥掉厂商前缀', () => {
    assert.equal(normalizeModelId('anthropic/claude-sonnet-5'), 'claude-sonnet-5');
});

test('剥掉区域前缀', () => {
    assert.equal(normalizeModelId('us.anthropic.claude-sonnet-5'), 'claude-sonnet-5');
});

test('剥掉日期后缀', () => {
    assert.equal(normalizeModelId('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
});

test('剥掉 bedrock 版本后缀', () => {
    assert.equal(normalizeModelId('claude-sonnet-4-5-20250929-v1:0'), 'claude-sonnet-4-5');
});

test('剥掉 @default', () => {
    assert.equal(normalizeModelId('vertex_ai/claude-sonnet-5@default'), 'claude-sonnet-5');
});

test('大小写不敏感', () => {
    assert.equal(normalizeModelId('Claude-Sonnet-5'), 'claude-sonnet-5');
});

test('候选列表含原始与归一形式', () => {
    const c = modelCandidates('anthropic/claude-sonnet-5');
    assert.ok(c.includes('anthropic/claude-sonnet-5'));
    assert.ok(c.includes('claude-sonnet-5'));
});

console.log('\n=== 价格查找 ===');

const prices = {
    'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2 },
    'deepseek-chat': { in: 0.28, out: 0.42 },
};

test('按原始 id 精确命中', () => {
    const r = findPrice(prices, 'deepseek-chat');
    assert.equal(r.price.in, 0.28);
    assert.equal(r.isDefault, false);
});

test('按归一 id 命中', () => {
    const r = findPrice(prices, 'anthropic/claude-sonnet-5');
    assert.equal(r.price.out, 10);
    assert.equal(r.matchedKey, 'claude-sonnet-5');
});

test('找不到时用默认价', () => {
    const r = findPrice(prices, 'unknown-model', { in: 1, out: 2 });
    assert.equal(r.price.in, 1);
    assert.equal(r.isDefault, true);
});

test('既没配也没默认 → 返回 null', () => {
    const r = findPrice(prices, 'unknown-model', null);
    assert.equal(r.price, null);
});

test('空价格表不算命中', () => {
    const r = findPrice({ 'x': { in: null, out: null } }, 'x', null);
    assert.equal(r.price, null);
});

test('只有填了输出价也算可用', () => {
    assert.equal(isUsablePrice({ in: null, out: 10 }), true);
});

test('normalizePrice 把空串转 null', () => {
    const p = normalizePrice({ in: '', out: '5', cacheRead: null });
    assert.equal(p.in, null);
    assert.equal(p.out, 5);
    assert.equal(p.cacheRead, null);
});

console.log('\n=== 费用计算 ===');

const p = { in: 2, out: 10, cacheRead: 0.2, cacheWrite: null };

test('基本计算', () => {
    const c = computeCost({ input: 1000, output: 100 }, p);
    assert.equal(c, (1000 * 2 + 100 * 10) / 1e6);
});

test('缓存 token 不重复计入普通输入', () => {
    const c = computeCost({ input: 1000, output: 0, cached: 400 }, p);
    // 600 新输入 * 2 + 400 缓存 * 0.2
    assert.equal(c, (600 * 2 + 400 * 0.2) / 1e6);
});

test('缓存读价没填时按输入价算', () => {
    const c = computeCost({ input: 1000, output: 0, cached: 400 }, { in: 2, out: 10, cacheRead: null });
    assert.equal(c, (1000 * 2) / 1e6);
});

test('缓存命中数超过输入数时按 0 计新输入', () => {
    const c = computeCost({ input: 100, output: 0, cached: 500 }, p);
    assert.equal(c, (500 * 0.2) / 1e6);
});

test('空 usage 返回 0', () => {
    assert.equal(computeCost({}, p), 0);
});

test('负数被夹为 0', () => {
    assert.equal(computeCost({ input: -5, output: -5 }, p), 0);
});

test('cacheWrite 计入', () => {
    const c = computeCost(
        { input: 0, output: 0, cacheWrite: 1000 },
        { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    );
    assert.equal(c, (1000 * 2.5) / 1e6);
});

console.log('\n=== 记录构建 ===');

test('无价格时 cost 为 null', () => {
    const r = buildRecord({ input: 100, output: 10 }, null, 'm');
    assert.equal(r.cost, null);
});

test('API 报 cost 时直接采用', () => {
    const r = buildRecord({ input: 100, output: 10, cost: 0.00123 }, p, 'm');
    assert.equal(r.cost, 0.00123);
    assert.equal(r.source, 'api-cost');
});

test('估算来源标记正确', () => {
    const r = buildRecord({ input: 100, output: 10, source: 'estimate' }, p, 'm');
    assert.equal(r.source, 'estimate');
    assert.ok(r.cost > 0);
});

console.log('\n=== 汇总 ===');

test('summarize 累加', () => {
    const s = summarize([
        { input: 100, output: 10, cached: 0, cost: 0.001 },
        { input: 200, output: 20, cached: 5, cost: 0.002 },
    ]);
    assert.equal(s.input, 300);
    assert.equal(s.output, 30);
    assert.equal(s.cached, 5);
    assert.equal(s.count, 2);
    assert.ok(Math.abs(s.cost - 0.003) < 1e-12);
});

test('summarize 处理空数组', () => {
    assert.equal(summarize([]).count, 0);
    assert.equal(summarize(null).count, 0);
});

console.log('\n=== SSE usage 解析 ===');

test('OpenAI 形状', () => {
    const u = parseSseLine('data: {"usage":{"prompt_tokens":100,"completion_tokens":20}}');
    assert.equal(u.input, 100);
    assert.equal(u.output, 20);
    assert.equal(u.source, 'api');
});

test('OpenAI 缓存字段', () => {
    const u = parseSseLine('data: {"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":40}}}');
    assert.equal(u.cached, 40);
});

test('OpenAI cost 标记为账单真值', () => {
    const u = parseSseLine('data: {"usage":{"prompt_tokens":100,"completion_tokens":20,"cost":0.005}}');
    assert.equal(u.cost, 0.005);
    assert.equal(u.source, 'api-cost');
});

test('upstream_inference_cost', () => {
    const u = parseSseLine('data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"cost_details":{"upstream_inference_cost":0.002}}}');
    assert.equal(u.cost, 0.002);
});

test('Anthropic message_start', () => {
    const u = parseSseLine('data: {"type":"message_start","message":{"usage":{"input_tokens":500}}}');
    assert.equal(u.input, 500);
    assert.equal(u.output, 0);
});

test('Anthropic message_delta', () => {
    const u = parseSseLine('data: {"type":"message_delta","usage":{"output_tokens":120}}');
    assert.equal(u.output, 120);
});

test('Anthropic 缓存字段', () => {
    const u = parseSseLine('data: {"type":"message_start","message":{"usage":{"input_tokens":500,"cache_read_input_tokens":300,"cache_creation_input_tokens":100}}}');
    assert.equal(u.cached, 300);
    assert.equal(u.cacheWrite, 100);
});

test('Gemini usageMetadata', () => {
    const u = parseSseLine('data: {"usageMetadata":{"promptTokenCount":800,"candidatesTokenCount":150,"cachedContentTokenCount":200}}');
    assert.equal(u.input, 800);
    assert.equal(u.output, 150);
    assert.equal(u.cached, 200);
});

test('非 data 行返回 null', () => {
    assert.equal(parseSseLine('event: message'), null);
    assert.equal(parseSseLine(''), null);
});

test('[DONE] 返回 null', () => {
    assert.equal(parseSseLine('data: [DONE]'), null);
});

test('坏 JSON 不抛异常', () => {
    assert.equal(parseSseLine('data: {broken'), null);
});

test('多帧合并(Anthropic start+delta)', () => {
    const text = [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":500}}}',
        'data: {"type":"message_delta","usage":{"output_tokens":120}}',
        'data: [DONE]',
    ].join('\n');
    const u = parseSseText(text);
    assert.equal(u.input, 500);
    assert.equal(u.output, 120);
});

test('非流式 JSON 响应', () => {
    const u = parseUsageFromBody('{"usage":{"prompt_tokens":10,"completion_tokens":5}}');
    assert.equal(u.input, 10);
    assert.equal(u.output, 5);
});

test('mergeUsage 保留 cost', () => {
    const m = mergeUsage(
        { input: 1, output: 0, cached: 0, cacheWrite: 0, cost: null, source: 'api' },
        { input: 0, output: 2, cached: 0, cacheWrite: 0, cost: 0.5, source: 'api-cost' },
    );
    assert.equal(m.cost, 0.5);
    assert.equal(m.input, 1);
    assert.equal(m.output, 2);
});

console.log('\n=== 请求识别 ===');

test('识别 chat-completions generate', () => {
    assert.equal(isGenerateUrl('/api/backends/chat-completions/generate'), true);
});

test('识别 text-completions generate', () => {
    assert.equal(isGenerateUrl('/api/backends/text-completions/generate'), true);
});

test('不误伤其他接口', () => {
    assert.equal(isGenerateUrl('/api/backends/chat-completions/status'), false);
    assert.equal(isGenerateUrl('/api/settings/get'), false);
    assert.equal(isGenerateUrl(''), false);
    assert.equal(isGenerateUrl(null), false);
});

test('从请求体取模型名', () => {
    const init = { body: JSON.stringify({ custom_model: 'deepseek-chat' }) };
    assert.equal(extractModelFromInit(init), 'deepseek-chat');
});

test('请求体坏掉不抛异常', () => {
    assert.equal(extractModelFromInit({ body: 'not json' }), '');
    assert.equal(extractModelFromInit(null), '');
});

console.log('\n=== 端到端场景 ===');

test('真实 RP 场景:claude-sonnet-5 6000in+300out', () => {
    const price = { in: 2, out: 10, cacheRead: 0.2, cacheWrite: null };
    const r = buildRecord({ input: 6000, output: 300 }, price, 'claude-sonnet-5');
    assert.equal(r.cost, (6000 * 2 + 300 * 10) / 1e6); // 0.015
});

test('缓存 90% 命中时明显更便宜', () => {
    const price = { in: 2, out: 10, cacheRead: 0.2, cacheWrite: null };
    const noCache = buildRecord({ input: 6000, output: 300 }, price, 'm').cost;
    const cached = buildRecord({ input: 6000, output: 300, cached: 5400 }, price, 'm').cost;
    assert.ok(cached < noCache);
    // 600*2 + 5400*0.2 + 300*10 = 1200 + 1080 + 3000 = 5280 / 1e6
    assert.ok(Math.abs(cached - 0.00528) < 1e-12);
});

console.log('\n' + '='.repeat(50));
console.log(`通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exit(1);
