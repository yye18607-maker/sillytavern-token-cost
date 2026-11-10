/**
 * Token 费用计算器 —— 酒馆 / TauriTavern 通用前端扩展
 *
 * 功能:
 * - 按模型分别填写单价(用户自己填,不内置官方价表)
 * - 自动抓取当前这一轮的真实 token 用量;抓不到时用酒馆分词器估算
 * - 也支持手动填写 token 数量来试算
 * - 每条 AI 消息下方显示花费徽章;面板里有会话/今日累计
 *
 * 设计原则:
 * - 纯前端扩展。TT 不支持 Node 后端插件,所以一切都在浏览器侧完成。
 * - 价格不内置 —— 避免官方价过期带来的维护成本与误导。
 * - 数据来源必须可见:实测 / 估算 / 手动,一眼分清。
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getTokenCountAsync, countTokensOpenAIAsync } from '../../../tokenizers.js';
import { getChatCompletionModel } from '../../../openai.js';

import { findPrice, buildRecord, summarize, normalizeModelId } from './lib/pricing.js';
import { installUsageHook, normalizeUsage } from './lib/usage.js';
import {
    loadSettings, attachRecord, readRecord, collectRecords,
    isTauriTavern, MODULE_NAME,
} from './lib/storage.js';

const EXT_NAME = 'TokenCost';

/** 等待中的 usage(按请求顺序排队) */
const pendingUsages = [];
/** 等待与消息配对的估算任务 */
let pendingEstimate = null;
/** 记录已处理过的消息,避免重复统计 */
const handledMessages = new Set();

// ─────────────────────────────────────────────
// 基础工具
// ─────────────────────────────────────────────

/**
 * 格式化费用显示。小额需要更多小数位。
 * @param {number} cost
 * @param {string} currency
 * @returns {string}
 */
function formatCost(cost, currency = '$') {
    if (cost === null || cost === undefined || !Number.isFinite(cost)) return '—';
    if (cost === 0) return `${currency}0`;
    if (cost < 0.0001) return `${currency}${cost.toExponential(2)}`;
    if (cost < 0.01) return `${currency}${cost.toFixed(6)}`;
    if (cost < 1) return `${currency}${cost.toFixed(4)}`;
    return `${currency}${cost.toFixed(2)}`;
}

/**
 * 格式化 token 数量:超过 1000 用 k / M 缩写。
 * @param {number} n
 * @returns {string}
 */
function formatTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
    return String(Math.round(v));
}

/**
 * 数据来源的显示样式与文案。
 */
const SOURCE_META = {
    'api-cost': { cls: 'tc-src-api-cost', label: '账单' },
    'api': { cls: 'tc-src-api', label: '实测' },
    'estimate': { cls: 'tc-src-estimate', label: '估算' },
    'manual': { cls: 'tc-src-manual', label: '手动' },
};

/**
 * 获取当前使用的模型 id。
 *
 * 优先用酒馆官方的 getChatCompletionModel()(它知道每种 source 对应哪个字段),
 * 拿不到时退回手写候选列表。
 *
 * @returns {string}
 */
function currentModelId() {
    try {
        const official = getChatCompletionModel();
        if (typeof official === 'string' && official.trim()) return official.trim();
    } catch {
        // 某些 source 未连接时该函数可能抛错,忽略
    }

    const ctx = getContext();
    const s = ctx?.chatCompletionSettings || {};
    const candidates = [
        s.custom_model, s.openai_model, s.claude_model, s.google_model,
        s.deepseek_model, s.moonshot_model, s.zai_model, s.openrouter_model, s.model,
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return s.chat_completion_source || '';
}

/**
 * 取设置对象。
 * @returns {object}
 */
function settings() {
    return loadSettings(extension_settings);
}

/**
 * 保存设置。
 */
function persist() {
    saveSettingsDebounced();
}

// ─────────────────────────────────────────────
// 计费主流程
// ─────────────────────────────────────────────

/**
 * 给一条消息计算并记录费用。
 *
 * @param {object} message 消息对象
 * @param {object} usage usage 数据
 * @param {string} modelId 模型 id
 */
function applyUsage(message, usage, modelId) {
    const s = settings();
    const { price } = findPrice(s.prices, modelId, s.defaultPrice);

    const record = buildRecord(usage, price, modelId);
    attachRecord(message, record);

    // 估算来源且没配价格时,cost 会是 null,提示用户填价格
    return record;
}

/**
 * fetch hook 拿到的 usage → 尝试配对到消息。
 * @param {object} usage
 * @param {object} meta
 */
function onUsageCaptured(usage, meta) {
    const s = settings();
    if (!s.autoCapture) return;

    const modelId = meta?.model || currentModelId();
    pendingUsages.push({ usage, modelId });
    if (pendingUsages.length > 32) pendingUsages.shift();
}

/**
 * 消息收到时结算这一轮的花费。
 * @param {number} messageId 消息下标
 * @param {string} type
 */
async function handleMessageReceived(messageId, type) {
    // 静默调用(摘要/引导生成)不产生消息,单独在 handleGenerationStarted 里 flush
    if (type === 'quiet') return;

    const ctx = getContext();
    const message = ctx?.chat?.[messageId];
    if (!message) return;

    // 已经算过的不重复算
    if (handledMessages.has(messageId)) return;

    const captured = pendingUsages.shift();
    const modelId = captured?.modelId || currentModelId();

    let usage = captured?.usage ?? null;

    // 没抓到 API usage → 用酒馆分词器估算
    if (!usage && settings().useEstimate) {
        usage = await estimateUsage(message, modelId);
    }

    if (!usage) return;

    applyUsage(message, usage, modelId);
    handledMessages.add(messageId);
    renderBadge(messageId);
    renderSummary();
    persist();
}

/**
 * 用酒馆原生分词器估算这一轮的 token。
 *
 * 输入侧: 监听 CHAT_COMPLETION_PROMPT_READY 时缓存的真实 prompt(最准)
 * 输出侧: message.extra.token_count 或直接分词
 *
 * @param {object} message 消息对象
 * @param {string} modelId
 * @returns {Promise<object|null>}
 */
async function estimateUsage(message, modelId) {
    const s = settings();
    if (!s.useEstimate) return null;

    let input = 0;
    let output = 0;

    // 输出侧:优先用酒馆已算好的(包含 reasoning token)
    if (Number.isFinite(message.extra?.token_count)) {
        output = message.extra.token_count;
    } else {
        try {
            output = await getTokenCountAsync((message.extra?.reasoning || '') + (message.mes || ''), 0);
        } catch {
            output = 0;
        }
    }

    // 输入侧:用生成时缓存的真实 prompt
    if (pendingEstimate?.promptCount) {
        input = pendingEstimate.promptCount;
    } else if (pendingEstimate?.messages) {
        try {
            input = await countTokensOpenAIAsync(pendingEstimate.messages);
        } catch {
            input = 0;
        }
    }
    pendingEstimate = null;

    if (!input && !output) return null;

    return {
        input,
        output,
        cached: 0,
        cacheWrite: 0,
        cost: null,
        source: 'estimate',
    };
}

/**
 * 生成开始时重置估算状态。
 */
function handleGenerationStarted(type) {
    pendingEstimate = null;
    pendingUsages.length = 0;
}

/**
 * prompt 准备好时缓存输入侧的 token 数。
 */
async function handlePromptReady(eventData) {
    if (!eventData?.chat) return;
    try {
        const count = await countTokensOpenAIAsync(eventData.chat);
        pendingEstimate = { promptCount: count, messages: eventData.chat };
    } catch {
        pendingEstimate = null;
    }
}

/**
 * 静默调用结算:后台请求不产生消息,单独记录。
 */
function handleQuietFlush() {
    const captured = pendingUsages.shift();
    if (!captured) return;
    // 静默调用的费用挂到当前最后一条消息上,避免完全丢失
    const ctx = getContext();
    const chat = ctx?.chat;
    if (!Array.isArray(chat) || !chat.length) return;

    const last = chat[chat.length - 1];
    const s = settings();
    const { price } = findPrice(s.prices, captured.modelId, s.defaultPrice);
    const record = buildRecord(captured.usage, price, captured.modelId);
    record.source = record.source === 'api' ? 'api' : record.source;
    record.quiet = true;

    if (!last.extra) last.extra = {};
    last.extra.tokenCostQuiet = record;
}

// ─────────────────────────────────────────────
// UI 渲染
// ─────────────────────────────────────────────

/**
 * 在消息下方渲染费用徽章。
 * @param {number} messageId
 */
function renderBadge(messageId) {
    const ctx = getContext();
    const message = ctx?.chat?.[messageId];
    const record = readRecord(message);
    if (!record) return;

    const s = settings();
    if (!s.showBadge) {
        removeBadge(messageId);
        return;
    }

    const meta = SOURCE_META[record.source] || SOURCE_META.estimate;
    const el = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!el) return;

    let badge = el.querySelector('.tc-badge');
    if (!badge) {
        badge = document.createElement('div');
        badge.className = 'tc-badge';
        el.appendChild(badge);
    }

    const cachedNote = record.cached > 0
        ? `<span class="tc-badge-cache" title="缓存命中 ${record.cached} tokens">缓存 ${formatTokens(record.cached)}</span>`
        : '';

    badge.innerHTML = `
        <span class="tc-badge-src ${meta.cls}" title="数据来源:${meta.label}">${meta.label}</span>
        <span class="tc-badge-cost">${formatCost(record.cost, s.currency)}</span>
        <span class="tc-badge-tokens">${formatTokens(record.input)}<span class="tc-sep">/</span>${formatTokens(record.output)}</span>
        ${cachedNote}
    `;
}

/**
 * 移除徽章。
 * @param {number} messageId
 */
function removeBadge(messageId) {
    const el = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    const badge = el?.querySelector('.tc-badge');
    badge?.remove();
}

/**
 * 渲染面板里的累计统计。
 */
function renderSummary() {
    const ctx = getContext();
    const s = settings();

    const records = collectRecords(ctx?.chat);
    const session = summarize(records);

    // 今日:按消息 index 无法可靠拿到时间戳,这里用「本次会话」作为统计口径,
    // 若消息带有 tokenCost.ts 则另外统计今日部分。
    const todayRecords = records.filter((r) => r.ts && isToday(r.ts));
    const today = summarize(todayRecords);

    const sessionEl = document.querySelector('#tc-summary-session');
    if (sessionEl) {
        sessionEl.innerHTML = `
            <span class="tc-stat-item"><b>${formatCost(session.cost, s.currency)}</b><i>花费</i></span>
            <span class="tc-stat-item"><b>${formatTokens(session.input)}</b><i>输入</i></span>
            <span class="tc-stat-item"><b>${formatTokens(session.output)}</b><i>输出</i></span>
            <span class="tc-stat-item"><b>${session.count}</b><i>轮次</i></span>
        `;
    }

    const todayEl = document.querySelector('#tc-summary-today');
    if (todayEl) {
        todayEl.innerHTML = `
            <span class="tc-stat-item"><b>${formatCost(today.cost, s.currency)}</b><i>花费</i></span>
            <span class="tc-stat-item"><b>${today.count}</b><i>轮次</i></span>
        `;
    }
}

/**
 * 判断时间戳是否是今天。
 * @param {number} ts
 * @returns {boolean}
 */
function isToday(ts) {
    try {
        const d = new Date(ts);
        const now = new Date();
        return d.getFullYear() === now.getFullYear()
            && d.getMonth() === now.getMonth()
            && d.getDate() === now.getDate();
    } catch {
        return false;
    }
}

/**
 * 渲染价格表。
 */
function renderPriceTable() {
    const s = settings();
    const tbody = document.querySelector('#tc-price-table tbody');
    if (!tbody) return;

    const modelId = currentModelId();
    const keys = Object.keys(s.prices);

    // 当前正在用的模型排最前
    keys.sort((a, b) => {
        if (a === modelId) return -1;
        if (b === modelId) return 1;
        return a.localeCompare(b);
    });

    if (!keys.length) {
        tbody.innerHTML = `
            <tr class="tc-empty-row">
                <td colspan="4" class="tc-empty">
                    还没有填过价格。下面加一个当前模型的价,或者手动填 token 试算。
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = keys.map((key) => {
        const p = s.prices[key] || {};
        const isCurrent = key === modelId;
        return `
            <tr class="${isCurrent ? 'tc-current' : ''}" data-model="${escapeAttr(key)}">
                <td class="tc-td-model">
                    ${escapeHtml(key)}
                    ${isCurrent ? '<span class="tc-tag-current">当前</span>' : ''}
                </td>
                <td><input type="number" class="tc-price-in" step="0.0001" min="0" placeholder="—" value="${p.in ?? ''}"></td>
                <td><input type="number" class="tc-price-out" step="0.0001" min="0" placeholder="—" value="${p.out ?? ''}"></td>
                <td><input type="number" class="tc-price-cache" step="0.0001" min="0" placeholder="—" value="${p.cacheRead ?? ''}"></td>
                <td><button class="tc-btn tc-btn-del" title="删除">×</button></td>
            </tr>
        `;
    }).join('');
}

/**
 * 渲染手动试算区。
 */
function renderManualCalc() {
    const s = settings();
    const inputEl = document.querySelector('#tc-manual-input');
    const outputEl = document.querySelector('#tc-manual-output');
    const resultEl = document.querySelector('#tc-manual-result');
    const modelEl = document.querySelector('#tc-manual-model');

    if (modelEl) {
        const cur = currentModelId();
        if (modelEl.value !== cur && document.activeElement !== modelEl) {
            modelEl.value = cur;
        }
    }

    const inp = Number(inputEl?.value) || 0;
    const out = Number(outputEl?.value) || 0;
    const model = modelEl?.value || currentModelId();
    const { price, isDefault } = findPrice(s.prices, model, s.defaultPrice);

    if (!price) {
        if (resultEl) {
            resultEl.innerHTML = `<span class="tc-hint">给「${escapeHtml(model || '该模型')}」填个价格才能算</span>`;
        }
        return;
    }

    const record = buildRecord({ input: inp, output: out, source: 'manual' }, price, model);
    if (resultEl) {
        const note = isDefault ? ' <i>(用的全局默认价)</i>' : '';
        resultEl.innerHTML = `
            <span class="tc-manual-cost">${formatCost(record.cost, s.currency)}</span>
            ${note}
        `;
    }
}

/**
 * 转义 HTML。
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 转义属性值。
 * @param {string} str
 * @returns {string}
 */
function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────
// 设置面板
// ─────────────────────────────────────────────

/**
 * 把面板 HTML 挂进酒馆的扩展设置区。
 */
async function mountSettingsPanel() {
    const container = document.querySelector('#extensions_settings2');
    if (!container || document.querySelector('#tc-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'tc-panel';
    panel.className = 'tc-panel';
    panel.innerHTML = buildPanelHtml();
    container.appendChild(panel);

    bindPanelEvents();
    renderPriceTable();
    renderManualCalc();
    renderSummary();
}

/**
 * 面板 HTML。
 * @returns {string}
 */
function buildPanelHtml() {
    return `
        <div class="tc-panel-head">
            <span class="tc-panel-title">Token 费用</span>
            <span class="tc-panel-sub">价格自己填 · token 自动抓</span>
        </div>

        <div class="tc-section">
            <div class="tc-section-head">
                <span class="tc-section-title">价格表</span>
                <span class="tc-section-hint">每百万 token · 美元</span>
            </div>

            <div class="tc-toolbar">
                <button id="tc-add-current" class="tc-btn tc-btn-primary">
                    ＋ 添加当前模型
                </button>
                <span id="tc-current-model" class="tc-current-model"></span>
            </div>

            <table id="tc-price-table" class="tc-table">
                <thead>
                    <tr>
                        <th>模型</th>
                        <th>输入</th>
                        <th>输出</th>
                        <th>缓存读</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>

            <details class="tc-details">
                <summary>全局默认价(兜底)</summary>
                <div class="tc-default-grid">
                    <label>输入<input type="number" id="tc-def-in" step="0.0001" min="0" placeholder="—"></label>
                    <label>输出<input type="number" id="tc-def-out" step="0.0001" min="0" placeholder="—"></label>
                    <label>缓存读<input type="number" id="tc-def-cache" step="0.0001" min="0" placeholder="—"></label>
                </div>
            </details>
        </div>

        <div class="tc-section">
            <div class="tc-section-head">
                <span class="tc-section-title">手动试算</span>
                <span class="tc-section-hint">填大概 token 数,立刻算钱</span>
            </div>
            <div class="tc-manual-grid">
                <label>模型<input type="text" id="tc-manual-model" placeholder="当前模型"></label>
                <label>输入 token<input type="number" id="tc-manual-input" min="0" placeholder="6000"></label>
                <label>输出 token<input type="number" id="tc-manual-output" min="0" placeholder="300"></label>
            </div>
            <div id="tc-manual-result" class="tc-manual-result"></div>
        </div>

        <div class="tc-section">
            <div class="tc-section-head">
                <span class="tc-section-title">统计</span>
                <span class="tc-section-hint">按天和会话累计</span>
                <button id="tc-export-csv" class="tc-btn tc-btn-small">导出 CSV</button>
            </div>
            <div class="tc-summary-row">
                <span class="tc-summary-label">本次会话</span>
                <div id="tc-summary-session" class="tc-stats"></div>
            </div>
            <div class="tc-summary-row">
                <span class="tc-summary-label">今日</span>
                <div id="tc-summary-today" class="tc-stats"></div>
            </div>
        </div>

        <div class="tc-section">
            <div class="tc-section-head"><span class="tc-section-title">选项</span></div>
            <div class="tc-options">
                <label class="tc-check">
                    <input type="checkbox" id="tc-opt-badge" checked>
                    <span>在消息下方显示费用徽章</span>
                </label>
                <label class="tc-check">
                    <input type="checkbox" id="tc-opt-capture" checked>
                    <span>自动抓取 API 返回的 token</span>
                </label>
                <label class="tc-check">
                    <input type="checkbox" id="tc-opt-estimate" checked>
                    <span>抓不到时用分词器估算</span>
                </label>
                <label class="tc-currency">
                    <span>货币符号</span>
                    <input type="text" id="tc-opt-currency" maxlength="3" placeholder="$">
                </label>
            </div>
        </div>
    `;
}

/**
 * 绑定面板交互。
 */
function bindPanelEvents() {
    const s = settings();

    // 当前模型名
    const curEl = document.querySelector('#tc-current-model');
    if (curEl) curEl.textContent = currentModelId() || '(未选择模型)';

    // 选项
    const badgeOpt = document.querySelector('#tc-opt-badge');
    if (badgeOpt) {
        badgeOpt.checked = s.showBadge;
        badgeOpt.addEventListener('change', () => {
            s.showBadge = badgeOpt.checked;
            persist();
            renderAllBadges();
        });
    }

    const captureOpt = document.querySelector('#tc-opt-capture');
    if (captureOpt) {
        captureOpt.checked = s.autoCapture;
        captureOpt.addEventListener('change', () => {
            s.autoCapture = captureOpt.checked;
            persist();
        });
    }

    const estOpt = document.querySelector('#tc-opt-estimate');
    if (estOpt) {
        estOpt.checked = s.useEstimate;
        estOpt.addEventListener('change', () => {
            s.useEstimate = estOpt.checked;
            persist();
        });
    }

    const curInput = document.querySelector('#tc-opt-currency');
    if (curInput) {
        curInput.value = s.currency;
        curInput.addEventListener('input', () => {
            s.currency = curInput.value || '$';
            persist();
            renderSummary();
            renderAllBadges();
            renderManualCalc();
        });
    }

    // 默认价
    const bindDefault = (sel, key) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.value = s.defaultPrice[key] ?? '';
        el.addEventListener('input', () => {
            const v = el.value === '' ? null : Number(el.value);
            s.defaultPrice[key] = (Number.isFinite(v) && v >= 0) ? v : null;
            persist();
            renderManualCalc();
        });
    };
    bindDefault('#tc-def-in', 'in');
    bindDefault('#tc-def-out', 'out');
    bindDefault('#tc-def-cache', 'cacheRead');

    // 添加当前模型
    const addBtn = document.querySelector('#tc-add-current');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            const modelId = currentModelId();
            if (!modelId) return;
            const key = normalizeModelId(modelId) || modelId;
            if (!s.prices[key]) {
                s.prices[key] = { in: null, out: null, cacheRead: null, cacheWrite: null };
                persist();
                renderPriceTable();
                renderManualCalc();
            }
        });
    }

    // 价格表编辑
    const table = document.querySelector('#tc-price-table');
    if (table) {
        table.addEventListener('input', (e) => {
            const tr = e.target.closest('tr[data-model]');
            if (!tr) return;
            const key = tr.dataset.model;
            if (!s.prices[key]) return;

            const field = e.target.classList.contains('tc-price-in') ? 'in'
                : e.target.classList.contains('tc-price-out') ? 'out'
                    : e.target.classList.contains('tc-price-cache') ? 'cacheRead' : null;
            if (!field) return;

            const v = e.target.value === '' ? null : Number(e.target.value);
            s.prices[key][field] = (Number.isFinite(v) && v >= 0) ? v : null;
            persist();
            renderManualCalc();
            renderAllBadges();
        });

        table.addEventListener('click', (e) => {
            const btn = e.target.closest('.tc-btn-del');
            if (!btn) return;
            const tr = btn.closest('tr[data-model]');
            if (!tr) return;
            delete s.prices[tr.dataset.model];
            persist();
            renderPriceTable();
            renderManualCalc();
            renderAllBadges();
        });
    }

    // 手动试算
    for (const sel of ['#tc-manual-model', '#tc-manual-input', '#tc-manual-output']) {
        const el = document.querySelector(sel);
        if (el) el.addEventListener('input', renderManualCalc);
    }

    // 导出 CSV
    const exportBtn = document.querySelector('#tc-export-csv');
    if (exportBtn) exportBtn.addEventListener('click', exportCsv);
}

/**
 * 重新渲染所有消息的徽章。
 */
function renderAllBadges() {
    const ctx = getContext();
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return;
    for (let i = 0; i < chat.length; i++) {
        if (readRecord(chat[i])) renderBadge(i);
    }
}

/**
 * 导出当前聊天的计费明细为 CSV。
 */
function exportCsv() {
    const ctx = getContext();
    const s = settings();
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return;

    const rows = [['序号', '模型', '输入', '输出', '缓存命中', '花费', '来源']];
    chat.forEach((msg, i) => {
        const r = readRecord(msg);
        if (!r) return;
        rows.push([
            i, r.model || '', r.input, r.output, r.cached,
            r.cost === null ? '' : r.cost.toFixed(8),
            SOURCE_META[r.source]?.label || r.source,
        ]);
    });

    const csv = rows.map((row) => row.map((cell) => {
        const v = String(cell ?? '');
        return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(',')).join('\n');

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `token-cost-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────

/**
 * 注册事件监听。
 */
function registerEvents() {
    eventSource.on(event_types.MESSAGE_RECEIVED, async (messageId, type) => {
        try {
            await handleMessageReceived(messageId, type);
        } catch (error) {
            console.error('[TokenCost] handle message failed:', error);
        }
    });

    eventSource.on(event_types.GENERATION_STARTED, (type) => {
        handleGenerationStarted(type);
    });

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async (eventData) => {
        try {
            await handlePromptReady(eventData);
        } catch (error) {
            console.debug('[TokenCost] prompt ready failed:', error);
        }
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        handledMessages.clear();
        pendingUsages.length = 0;
        pendingEstimate = null;
        renderSummary();
    });

    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, () => {
        renderPriceTable();
        renderManualCalc();
        renderSummary();
    });
}

/**
 * 扩展入口。
 */
async function init() {
    console.log(`[TokenCost] 初始化 · ${isTauriTavern() ? 'TauriTavern' : 'SillyTavern'}`);

    const s = settings();

    // 装 fetch hook
    if (s.autoCapture) {
        const ok = installUsageHook(onUsageCaptured);
        console.log(`[TokenCost] fetch hook: ${ok ? '已安装' : '跳过'}`);
    }

    registerEvents();

    // 面板挂载(等酒馆的扩展面板存在)
    await mountSettingsPanel();

    // 已有聊天里的历史记录渲染徽章
    renderAllBadges();
    renderSummary();
}

// 酒馆加载完再跑
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void init());
} else {
    void init();
}

export { formatCost, formatTokens, escapeHtml };
