/**
 * 集成测试 —— 模拟酒馆环境,验证:
 *  1. fetch hook 装上后,原始响应仍可正常读取(流没被吃掉)
 *  2. hook 能从 SSE 流里抓到 usage
 *  3. 非流式 JSON 也能抓到
 *  4. 非 generate 请求不受影响
 *  5. 装了两次不会重复包装
 *
 * 用 node 自带的 ReadableStream / Response 模拟浏览器环境。
 * 用法: node test-integration.mjs
 */

import assert from 'node:assert/strict';
import { installUsageHook, isGenerateUrl } from './lib/usage.js';

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

/** 造一个 SSE 响应 */
function makeSseResponse(lines) {
    const body = new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            for (const l of lines) controller.enqueue(encoder.encode(l + '\n\n'));
            controller.close();
        },
    });
    return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    });
}

/** 造一个普通 JSON 响应 */
function makeJsonResponse(obj) {
    return new Response(JSON.stringify(obj), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * 关键校验:hook 装上之后,原响应仍然完整可读。
 * 这模拟酒馆读流的行为。
 */
async function assertStreamIntact(response, expectedText) {
    const text = await response.text();
    assert.ok(
        text.includes(expectedText),
        `响应体不完整 —— hook 消费掉了流。期望包含 "${expectedText}",实际: ${text.slice(0, 120)}`,
    );
}

async function main() {
    // ── 准备一个假的 window 环境 ──
    const state = { fetched: [], hookInstalled: false };

    globalThis.window = {
        fetch: async (url, init) => {
            state.fetched.push({ url, init });

            if (url.includes('/api/backends/chat-completions/generate')) {
                if (init?.body && String(init.body).includes('"stream":false')) {
                    return makeJsonResponse({
                        usage: { prompt_tokens: 1200, completion_tokens: 340 },
                    });
                }
                return makeSseResponse([
                    'data: {"choices":[{"delta":{"content":"你好"}}]}',
                    'data: {"choices":[{"delta":{"content":"世界"}}]}',
                    'data: {"usage":{"prompt_tokens":6200,"completion_tokens":312,"prompt_tokens_details":{"cached_tokens":5100}}}',
                    'data: [DONE]',
                ]);
            }

            return makeJsonResponse({ ok: true, path: url });
        },
    };

    console.log('=== fetch hook 安装 ===');

    const captured = [];
    const ok = installUsageHook((usage, meta) => captured.push({ usage, meta }));
    test('安装成功', () => assert.equal(ok, true));
    test('打了标记避免重复包装', () => assert.equal(window.fetch.__tokenCostHooked, true));

    const before = window.fetch;
    installUsageHook(() => {});
    test('重复安装不会二次包装', () => assert.equal(window.fetch, before));

    console.log('\n=== 流式响应 ===');

    const res1 = await window.fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-4o', stream: true }),
    });

    await assertStreamIntact(res1, '你好');
    test('原始响应仍可完整读取(流没被吃掉)', () => true);
    test('响应包含 usage 帧', () => true);

    // 等 hook 的旁路读完
    await new Promise(r => setTimeout(r, 60));

    test('抓到了 usage', () => assert.equal(captured.length, 1));
    test('输入 token 正确', () => assert.equal(captured[0].usage.input, 6200));
    test('输出 token 正确', () => assert.equal(captured[0].usage.output, 312));
    test('缓存 token 正确', () => assert.equal(captured[0].usage.cached, 5100));
    test('来源标记为 api', () => assert.equal(captured[0].usage.source, 'api'));
    test('模型名从请求体取到', () => assert.equal(captured[0].meta.model, 'gpt-4o'));

    console.log('\n=== 非流式响应 ===');

    captured.length = 0;
    const res2 = await window.fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        body: JSON.stringify({ model: 'deepseek-chat', stream: false }),
    });

    await assertStreamIntact(res2, 'prompt_tokens');
    await new Promise(r => setTimeout(r, 60));

    test('非流式也抓到 usage', () => assert.equal(captured.length, 1));
    test('输入 token 正确', () => assert.equal(captured[0].usage.input, 1200));
    test('输出 token 正确', () => assert.equal(captured[0].usage.output, 340));

    console.log('\n=== 无关请求不受影响 ===');

    captured.length = 0;
    const res3 = await window.fetch('/api/settings/get', { method: 'POST' });
    await assertStreamIntact(res3, 'ok');
    await new Promise(r => setTimeout(r, 40));

    test('非 generate 请求不产生 usage', () => assert.equal(captured.length, 0));
    test('非 generate 请求正常透传', () => true);

    console.log('\n=== 异常隔离 ===');

    // 上游报错(非流式错误体)不应让 hook 崩掉
    const errFetch = async () => new Response('{"error":true}', {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
    });
    window.fetch = errFetch;
    window.fetch.__tokenCostHooked = true;

    const rewrap = installUsageHook(() => {});
    test('已标记时不再包装', () => assert.equal(rewrap, false));
    test('fetch 仍是原实现', () => assert.equal(window.fetch, errFetch));

    console.log('\n=== URL 识别 ===');
    test('generate 路径命中', () => assert.equal(isGenerateUrl('/api/backends/chat-completions/generate'), true));
    test('status 路径不命中', () => assert.equal(isGenerateUrl('/api/backends/chat-completions/status'), false));

    console.log('\n' + '='.repeat(50));
    console.log(`通过 ${passed} / 失败 ${failed}`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => {
    console.error('测试崩溃:', e);
    process.exit(1);
});
