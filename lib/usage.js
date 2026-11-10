/**
 * 抓取「当前这一轮」的 token 用量。
 *
 * 两条来源,自动选优:
 *   A. API 返回的 usage —— 准确,但只有上游主动返回才有
 *   B. 酒馆自己的分词器 —— 永远可用,属于估算
 *
 * A 的实现: hook window.fetch,对 /api/backends/chat-completions/generate 的
 * 响应做 clone() 后解析 SSE 流里各家格式的 usage。
 *
 * 关键安全点: 必须 clone()。直接读 response.text() 会消费掉 body,
 * 酒馆就读不到流,聊天会直接卡死。
 */

const GENERATE_URLS = [
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
];

/**
 * 从 SSE 的一行里解析 usage。
 * 兼容 OpenAI / Anthropic / Gemini / 部分中转的字段形状。
 *
 * @param {string} line SSE 行
 * @returns {object|null} usage 片段
 */
export function parseSseLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('data:')) return null;

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;

    let parsed;
    try {
        parsed = JSON.parse(payload);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    return normalizeUsage(parsed);
}

/**
 * 把各厂商的 usage 结构归一成统一形状。
 *
 * 统一形状: { input, output, cached, cacheWrite, cost }
 *
 * @param {object} parsed 解析后的 SSE JSON
 * @returns {object|null}
 */
export function normalizeUsage(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;

    // ── OpenAI 形状: { usage: { prompt_tokens, completion_tokens, ... } } ──
    const u = parsed.usage;
    if (u && typeof u === 'object') {
        const input = pickNum(u.prompt_tokens, u.input_tokens, u.promptTokens);
        const output = pickNum(u.completion_tokens, u.output_tokens, u.candidatesTokenCount);
        const cached = pickNum(
            u.prompt_tokens_details?.cached_tokens,
            u.cache_read_input_tokens,
            u.cachedContentTokenCount,
            u.prompt_cache_hit_tokens,
        );
        const cacheWrite = pickNum(u.cache_creation_input_tokens, u.cache_write_input_tokens);
        const cost = pickNum(u.cost, u.cost_details?.upstream_inference_cost);

        if (isNum(input) || isNum(output) || isNum(cost)) {
            return {
                input: input ?? 0,
                output: output ?? 0,
                cached: cached ?? 0,
                cacheWrite: cacheWrite ?? 0,
                cost: isNum(cost) ? cost : null,
                source: isNum(cost) ? 'api-cost' : 'api',
            };
        }
    }

    // ── Anthropic 原生: message_start / message_delta ──
    if (parsed.type === 'message_start' && parsed.message?.usage) {
        const mu = parsed.message.usage;
        return {
            input: pickNum(mu.input_tokens, mu.prompt_tokens) ?? 0,
            output: 0,
            cached: pickNum(mu.cache_read_input_tokens) ?? 0,
            cacheWrite: pickNum(mu.cache_creation_input_tokens) ?? 0,
            cost: null,
            source: 'api',
        };
    }
    if (parsed.type === 'message_delta' && parsed.usage) {
        return {
            input: 0,
            output: pickNum(parsed.usage.output_tokens) ?? 0,
            cached: 0,
            cacheWrite: 0,
            cost: null,
            source: 'api',
        };
    }

    // ── Gemini: { usageMetadata: {...} } ──
    if (parsed.usageMetadata && typeof parsed.usageMetadata === 'object') {
        const gm = parsed.usageMetadata;
        return {
            input: pickNum(gm.promptTokenCount) ?? 0,
            output: pickNum(gm.candidatesTokenCount) ?? 0,
            cached: pickNum(gm.cachedContentTokenCount) ?? 0,
            cacheWrite: 0,
            cost: null,
            source: 'api',
        };
    }

    // ── 中转的 opencode 扩展形状 ──
    if (parsed.opencode && typeof parsed.opencode === 'object') {
        const oc = parsed.opencode;
        const tokens = oc.tokens || {};
        const cost = pickNum(oc.allowance, oc.list_cost);
        return {
            input: pickNum(tokens.input) ?? 0,
            output: pickNum(tokens.output) ?? 0,
            cached: pickNum(tokens.cache_read) ?? 0,
            cacheWrite: pickNum(tokens.cache_write) ?? 0,
            cost: isNum(cost) ? cost : null,
            source: isNum(cost) ? 'api-cost' : 'api',
        };
    }

    return null;
}

/**
 * 从一段完整 SSE 文本里汇总出 usage。
 * 同一条流里可能有多个片段(如 Anthropic 的 start + delta),需要合并。
 *
 * @param {string} text SSE 全文
 * @returns {object|null}
 */
export function parseSseText(text) {
    if (!text || typeof text !== 'string') return null;

    let merged = null;
    for (const line of text.split(/\r?\n/)) {
        const part = parseSseLine(line);
        if (!part) continue;
        merged = merged ? mergeUsage(merged, part) : part;
    }
    return merged;
}

/**
 * 合并两个 usage 片段。
 *
 * 关键: 片段是"增量"而非"全量"。Anthropic 会先发 message_start(只有 input),
 * 再发 message_delta(只有 output)。所以合并时不能被对方的 0 覆盖 ——
 * 只有当一方为 0/缺失时才取另一方,两方都有值时取较大者。
 *
 * @param {object} a
 * @param {object} b
 * @returns {object}
 */
export function mergeUsage(a, b) {
    const pick = (x, y) => {
        const nx = Number(x) || 0;
        const ny = Number(y) || 0;
        if (nx > 0) return nx;
        if (ny > 0) return ny;
        return 0;
    };

    return {
        input: pick(a.input, b.input),
        output: pick(a.output, b.output),
        cached: pick(a.cached, b.cached),
        cacheWrite: pick(a.cacheWrite, b.cacheWrite),
        cost: isNum(a.cost) ? a.cost : (isNum(b.cost) ? b.cost : null),
        source: isNum(a.cost) ? a.source : (isNum(b.cost) ? b.source : (b.source || a.source)),
    };
}

/**
 * 从一段响应文本里提取 usage,兼顾 SSE 与普通 JSON 两种响应。
 * @param {string} text 响应文本
 * @returns {object|null}
 */
export function parseUsageFromBody(text) {
    if (!text || typeof text !== 'string') return null;

    const trimmed = text.trim();
    if (trimmed.startsWith('data:')) {
        return parseSseText(trimmed);
    }

    // 非流式:整个 body 就是 JSON
    try {
        const parsed = JSON.parse(trimmed);
        return normalizeUsage(parsed);
    } catch {
        // 可能是混合内容,再试一次 SSE
        return parseSseText(trimmed);
    }
}

/**
 * 判断是否是我们要拦截的生成请求。
 * @param {string} url
 * @returns {boolean}
 */
export function isGenerateUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return GENERATE_URLS.some((u) => url.includes(u));
}

/**
 * 安装 fetch hook。
 *
 * @param {(usage: object, meta: object) => void} onUsage 拿到 usage 时的回调
 * @returns {boolean} 是否成功安装
 */
export function installUsageHook(onUsage) {
    if (typeof window === 'undefined') return false;

    const current = window.fetch;
    if (!current || current.__tokenCostHooked) return false;

    const originalFetch = current.bind(window);

    const wrappedFetch = async function (input, init) {
        const response = await originalFetch(input, init);

        try {
            const url = typeof input === 'string'
                ? input
                : (input?.url || (input instanceof Request ? input.url : ''));

            if (isGenerateUrl(url)) {
                // 关键: clone()。直接消费 body 会让酒馆读不到流,聊天卡死。
                // 用 void 挂到微任务里,绝不能 await 阻塞主流程。
                void captureUsage(response.clone(), url, init, onUsage);
            }
        } catch (error) {
            console.debug('[TokenCost] fetch hook error:', error);
        }

        return response;
    };

    wrappedFetch.__tokenCostHooked = true;
    window.fetch = wrappedFetch;
    return true;
}

/**
 * 从克隆的响应里读出 usage。
 * @param {Response} cloned
 * @param {string} url
 * @param {object} init
 * @param {Function} onUsage
 */
async function captureUsage(cloned, url, init, onUsage) {
    try {
        const contentType = cloned.headers.get('content-type') || '';

        let text;
        if (contentType.includes('text/event-stream')) {
            text = await readAllText(cloned);
        } else {
            text = await cloned.text();
        }

        const usage = parseUsageFromBody(text);
        if (usage) {
            onUsage(usage, { url, model: extractModelFromInit(init) });
        }
    } catch (error) {
        // 静默失败:抓不到 usage 不该影响正常聊天
        console.debug('[TokenCost] capture usage failed:', error);
    }
}

/**
 * 读取流的全部文本。
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function readAllText(res) {
    if (!res.body) return await res.text();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let out = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();

    return out;
}

/**
 * 从请求体里提取模型名。
 * @param {object} init fetch 的 init 参数
 * @returns {string}
 */
export function extractModelFromInit(init) {
    try {
        const body = init?.body;
        if (typeof body !== 'string') return '';
        const parsed = JSON.parse(body);
        return String(
            parsed.custom_model || parsed.openai_model || parsed.model ||
            parsed.claude_model || parsed.google_model || parsed.deepseek_model || ''
        );
    } catch {
        return '';
    }
}

function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function pickNum(...vals) {
    for (const v of vals) {
        if (isNum(v)) return v;
    }
    return null;
}
