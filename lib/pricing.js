/**
 * 价格存取与费用计算。
 *
 * 设计要点:
 * - 价格全部由用户填写,扩展不内置任何官方价表(避免价格过期与维护成本)
 * - 按模型 id 分别记忆,切换模型自动带出上次填的价格
 * - 保留一个"全局默认价"作为兜底,省去每个模型都填一遍
 *
 * 所有单价单位统一为「美元 / 每百万 token」(USD per 1M tokens)。
 */

/** 单价兜底:某项没填时用它 */
const ZERO_PRICE = { in: 0, out: 0, cacheRead: null, cacheWrite: null };

/**
 * 归一化模型 id,用于价格查找。
 * 酒馆里同一个模型可能以不同写法出现:
 *   - 裸名:            claude-sonnet-5
 *   - 带厂商前缀:      anthropic/claude-sonnet-5
 *   - 带区域后缀:      us.anthropic.claude-sonnet-5
 *   - 带日期版本:      claude-sonnet-4-5-20250929
 * 归一化后便于跨厂商共用同一份价格。
 *
 * @param {string} raw 原始模型 id
 * @returns {string} 归一化后的 key
 */
export function normalizeModelId(raw) {
    if (typeof raw !== 'string') return '';
    let id = raw.trim().toLowerCase();
    if (!id) return '';

    // 剥掉厂商/区域前缀
    id = id.replace(/^(?:us|eu|au|jp|apac|global|us-gov)\./, '');
    id = id.replace(/^[a-z0-9_-]+\//, ''); // vendor/model → model
    id = id.replace(/^anthropic\./, '');

    // 剥掉尾部日期与版本标记
    // 顺序很重要: 先剥版本后缀(-v1:0),再剥日期,循环到稳定
    let changed = true;
    while (changed) {
        changed = false;

        // bedrock 版本后缀
        const before = id;
        id = id.replace(/-v\d+(?::\d+)?$/, '');
        if (id !== before) { changed = true; continue; }

        // 日期后缀
        id = id.replace(/@\d{8}/, '');
        id = id.replace(/-\d{8}$/, '');
        if (id !== before) { changed = true; continue; }

        // @default / -latest
        id = id.replace(/@default$/, '');
        id = id.replace(/-latest$/, '');
        if (id !== before) { changed = true; }
    }

    return id;
}

/**
 * 生成用于查找价格的一组候选 key,从最精确到最宽松。
 * @param {string} raw 原始模型 id
 * @returns {string[]} 候选 key
 */
export function modelCandidates(raw) {
    if (typeof raw !== 'string') return [];
    const lower = raw.trim().toLowerCase();
    if (!lower) return [];

    const list = [];
    const push = (v) => {
        if (v && !list.includes(v)) list.push(v);
    };

    push(lower);
    push(normalizeModelId(lower));
    // 带厂商前缀但去日期的形式,如 anthropic/claude-sonnet-4-5-20250929
    const slash = lower.indexOf('/');
    if (slash > 0) {
        push(lower.slice(slash + 1));
    }
    return list;
}

/**
 * 从价格表里找到某个模型的价格。
 *
 * 查找顺序:
 *   1. 精确匹配用户填的原始 id
 *   2. 归一化后匹配
 *   3. 全局默认价
 *
 * @param {object} prices 价格表 { [modelId]: {in,out,cacheRead,cacheWrite} }
 * @param {string} modelId 模型 id
 * @param {object} [fallback] 全局默认价
 * @returns {{price: object, matchedKey: string|null, isDefault: boolean}}
 */
export function findPrice(prices, modelId, fallback = null) {
    const table = prices && typeof prices === 'object' ? prices : {};

    for (const candidate of modelCandidates(modelId)) {
        const hit = table[candidate];
        if (hit && isUsablePrice(hit)) {
            return { price: normalizePrice(hit), matchedKey: candidate, isDefault: false };
        }
    }

    if (fallback && isUsablePrice(fallback)) {
        return { price: normalizePrice(fallback), matchedKey: null, isDefault: true };
    }

    return { price: null, matchedKey: null, isDefault: false };
}

/**
 * 价格是否可用(至少填了输入或输出其中之一)。
 * 注意: null / undefined / 空串都不算"填了 0",必须严格区分。
 * @param {object} price 价格对象
 * @returns {boolean}
 */
export function isUsablePrice(price) {
    if (!price || typeof price !== 'object') return false;

    const has = (v) => {
        if (v === null || v === undefined || v === '') return false;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0;
    };

    return has(price.in) || has(price.out);
}

/**
 * 补齐价格对象的字段,缺的用 null(表示"该项不计费")。
 * @param {object} price 原始价格
 * @returns {object} 规范价格
 */
export function normalizePrice(price) {
    const num = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : null;
    };
    return {
        in: num(price.in),
        out: num(price.out),
        cacheRead: num(price.cacheRead),
        cacheWrite: num(price.cacheWrite),
    };
}

/**
 * 计算一次调用的费用。
 *
 * 公式:
 *   费用 = (未命中输入 × 输入价
 *         + 命中缓存输入 × 缓存读价
 *         + 输出 × 输出价
 *         + 缓存写入 × 缓存写价) ÷ 1,000,000
 *
 * 缓存读价没填时,按输入价计算(保守估计,不虚报便宜)。
 *
 * @param {object} usage {input, output, cached, cacheWrite}
 * @param {object} price 规范后的价格
 * @returns {number|null} 费用(美元),无法计算时返回 null
 */
export function computeCost(usage, price) {
    if (!usage || !price) return null;

    const input = Math.max(0, Number(usage.input) || 0);
    const output = Math.max(0, Number(usage.output) || 0);
    const cached = Math.max(0, Number(usage.cached) || 0);
    const cacheWrite = Math.max(0, Number(usage.cacheWrite) || 0);

    const inPrice = price.in ?? 0;
    const outPrice = price.out ?? 0;
    const cacheReadPrice = price.cacheRead ?? inPrice;
    const cacheWritePrice = price.cacheWrite ?? 0;

    // 缓存命中的 token 不应该重复计入普通输入
    const billableInput = Math.max(0, input - cached);

    const total =
        billableInput * inPrice +
        cached * cacheReadPrice +
        output * outPrice +
        cacheWrite * cacheWritePrice;

    return total / 1_000_000;
}

/**
 * 把一次调用的 usage 和价格算成一条完整记录。
 *
 * @param {object} usage {input, output, cached, cacheWrite, cost, source}
 * @param {object} price 规范价格
 * @param {string} modelId 模型 id
 * @returns {object} 记录
 */
export function buildRecord(usage, price, modelId) {
    const record = {
        model: modelId || '',
        input: Math.max(0, Number(usage?.input) || 0),
        output: Math.max(0, Number(usage?.output) || 0),
        cached: Math.max(0, Number(usage?.cached) || 0),
        cacheWrite: Math.max(0, Number(usage?.cacheWrite) || 0),
        source: usage?.source || 'estimate',
        cost: null,
    };

    // 上游报了真实费用就直接用(账单级真值)
    if (Number.isFinite(Number(usage?.cost)) && Number(usage.cost) >= 0) {
        record.cost = Number(usage.cost);
        record.source = 'api-cost';
        return record;
    }

    record.cost = computeCost(record, price);
    return record;
}

/**
 * 汇总一批记录。
 * @param {object[]} records 记录数组
 * @returns {{input:number, output:number, cached:number, cost:number, count:number}}
 */
export function summarize(records) {
    const sum = { input: 0, output: 0, cached: 0, cost: 0, count: 0 };
    if (!Array.isArray(records)) return sum;

    for (const r of records) {
        if (!r) continue;
        sum.input += Number(r.input) || 0;
        sum.output += Number(r.output) || 0;
        sum.cached += Number(r.cached) || 0;
        sum.cost += Number(r.cost) || 0;
        sum.count += 1;
    }
    return sum;
}

export { ZERO_PRICE };
