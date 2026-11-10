/**
 * 存储抽象。
 *
 * 优先用酒馆原生 extension_settings(酒馆和 TT 都支持);
 * 检测到 TT 时,可选使用 TT 的 api.extension.store 做全局 KV。
 *
 * 计费明细存在每条消息的 extra.tokenCost 里,这样:
 * - 随聊天文件一起保存,换设备也在
 * - 天然按聊天隔离
 */

const MODULE_NAME = 'tokenCost';

const DEFAULT_SETTINGS = {
    /** 按模型 id 记忆的价格: { [modelId]: {in, out, cacheRead, cacheWrite} } */
    prices: {},
    /** 全局默认价(兜底) */
    defaultPrice: { in: null, out: null, cacheRead: null, cacheWrite: null },
    /** 货币符号 */
    currency: '$',
    /** 是否在消息下方显示费用徽章 */
    showBadge: true,
    /** 是否自动抓取 API usage */
    autoCapture: true,
    /** 是否用酒馆分词器做估算兜底 */
    useEstimate: true,
    /** 已处理的消息 id 集合,避免重复统计 */
    processed: [],
};

/**
 * 读取设置。
 * @param {object} extensionSettings 酒馆的 extension_settings 对象
 * @returns {object}
 */
export function loadSettings(extensionSettings) {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = extensionSettings[MODULE_NAME];

    // 兼容旧版本缺失的字段
    s.prices = s.prices && typeof s.prices === 'object' ? s.prices : {};
    s.defaultPrice = s.defaultPrice && typeof s.defaultPrice === 'object'
        ? s.defaultPrice
        : structuredClone(DEFAULT_SETTINGS.defaultPrice);
    s.processed = Array.isArray(s.processed) ? s.processed : [];
    if (typeof s.currency !== 'string' || !s.currency) s.currency = '$';

    return s;
}

/**
 * 判断是否运行在 TauriTavern。
 * @returns {boolean}
 */
export function isTauriTavern() {
    return typeof window !== 'undefined' && Boolean(window.__TAURITAVERN__);
}

/**
 * 把一条计费记录写进消息的 extra。
 * @param {object} message 消息对象
 * @param {object} record 计费记录
 */
export function attachRecord(message, record) {
    if (!message || typeof message !== 'object') return;
    if (!message.extra) message.extra = {};
    message.extra.tokenCost = record;
}

/**
 * 从消息里读出计费记录。
 * @param {object} message 消息对象
 * @returns {object|null}
 */
export function readRecord(message) {
    return message?.extra?.tokenCost ?? null;
}

/**
 * 收集当前聊天里所有带计费记录的消息。
 * @param {object[]} chat 聊天消息数组
 * @returns {object[]}
 */
export function collectRecords(chat) {
    if (!Array.isArray(chat)) return [];
    const out = [];
    for (const msg of chat) {
        const rec = readRecord(msg);
        if (rec) out.push(rec);
    }
    return out;
}

export { MODULE_NAME, DEFAULT_SETTINGS };
