/**
 * 静态检查:核对扩展对酒馆 API 的依赖是否都存在且用法正确。
 *
 * 检查项:
 *  1. import 路径能否解析到真实文件
 *  2. 从酒馆导入的符号是否真的被导出
 *  3. 扩展自身代码的语法是否正确
 *  4. 事件名是否存在于酒馆的 event_types
 *
 * 用法: node test-api-contract.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ST = resolve(HERE, '..', '..', '_research', 'st');

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
    if (cond) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

console.log('=== 酒馆源码是否可用 ===');
const stExists = existsSync(ST);
check('找到酒馆源码(用于校验 API)', stExists, ST);
if (!stExists) {
    console.log('\n跳过 API 契约校验(没有酒馆源码)');
    process.exit(0);
}

console.log('\n=== import 路径解析 ===');

// 扩展在 <酒馆>/public/scripts/extensions/third-party/<name>/ 时,
// 相对路径基于 public/scripts/extensions/third-party/<name>/
// 但源码里第三方扩展实际位于 data/default-user/extensions/<name>/
// 酒馆会把它们映射到同一 URL 前缀,所以用 public/scripts/extensions/third-party 模拟。
const EXT_BASE = join(ST, 'public', 'scripts', 'extensions', 'third-party', 'TokenCost');
const IMPORTS = [
    { spec: '../../../../script.js', expect: join(ST, 'public', 'script.js') },
    { spec: '../../../extensions.js', expect: join(ST, 'public', 'scripts', 'extensions.js') },
    { spec: '../../../tokenizers.js', expect: join(ST, 'public', 'scripts', 'tokenizers.js') },
    { spec: '../../../openai.js', expect: join(ST, 'public', 'scripts', 'openai.js') },
];

for (const imp of IMPORTS) {
    const resolved = join(EXT_BASE, imp.spec);
    check(`${imp.spec} → 存在`, existsSync(resolved), resolved);
}

// 相对路径的 lib/ 引用
for (const spec of ['./lib/pricing.js', './lib/usage.js', './lib/storage.js']) {
    check(`${spec} → 存在`, existsSync(join(HERE, spec)));
}

console.log('\n=== 从酒馆导入的符号是否真的导出 ===');

const scriptJs = readFileSync(join(ST, 'public', 'script.js'), 'utf8');
const extensionsJs = readFileSync(join(ST, 'public', 'scripts', 'extensions.js'), 'utf8');
const tokenizersJs = readFileSync(join(ST, 'public', 'scripts', 'tokenizers.js'), 'utf8');
const eventsJs = readFileSync(join(ST, 'public', 'scripts', 'events.js'), 'utf8');
const openaiJs = readFileSync(join(ST, 'public', 'scripts', 'openai.js'), 'utf8');

const NEEDED = [
    { file: scriptJs, name: 'script.js', symbols: ['eventSource', 'event_types', 'saveSettingsDebounced'] },
    { file: extensionsJs, name: 'extensions.js', symbols: ['extension_settings', 'getContext'] },
    { file: tokenizersJs, name: 'tokenizers.js', symbols: ['getTokenCountAsync', 'countTokensOpenAIAsync'] },
    { file: openaiJs, name: 'openai.js', symbols: ['getChatCompletionModel'] },
];

for (const grp of NEEDED) {
    for (const sym of grp.symbols) {
        // 匹配 export { ... } 块或 export const/function/class
        const reExport = new RegExp(`export\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}`, 's');
        const reDecl = new RegExp(`export\\s+(?:const|let|var|function|async function|class)\\s+${sym}\\b`);
        const ok = reExport.test(grp.file) || reDecl.test(grp.file);
        check(`${grp.name} 导出 ${sym}`, ok);
    }
}

console.log('\n=== 使用的事件名是否存在于 event_types ===');
const eventNames = ['MESSAGE_RECEIVED', 'GENERATION_STARTED', 'CHAT_COMPLETION_PROMPT_READY',
    'CHAT_CHANGED', 'EXTENSION_SETTINGS_LOADED'];
for (const ev of eventNames) {
    check(`event_types.${ev}`, new RegExp(`\\b${ev}\\s*:`).test(eventsJs));
}

console.log('\n=== getContext 的字段名 ===');
const ctxSrc = readFileSync(join(ST, 'public', 'scripts', 'st-context.js'), 'utf8');
check('getContext 暴露 chat', /^\s*chat\s*,/m.test(ctxSrc));
check('getContext 暴露 chatCompletionSettings', /chatCompletionSettings\s*:/.test(ctxSrc));
check('扩展用的是 chatCompletionSettings(不是 oai_settings)',
    !/ctx\?\.oai_settings/.test(readFileSync(join(HERE, 'index.js'), 'utf8')));

console.log('\n=== 扩展代码语法检查 ===');
const files = ['index.js', 'lib/pricing.js', 'lib/usage.js', 'lib/storage.js'];
for (const f of files) {
    const full = join(HERE, f);
    try {
        execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
        check(`${f} 语法正确`, true);
    } catch (e) {
        check(`${f} 语法正确`, false, String(e.stderr || e.message).split('\n').slice(0, 3).join(' '));
    }
}

console.log('\n=== manifest.json ===');
try {
    const m = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));
    check('是合法 JSON', true);
    check('有 display_name', typeof m.display_name === 'string' && m.display_name.length > 0);
    check('有 js 入口', m.js === 'index.js');
    check('有 css', m.css === 'style.css');
    check('有 version', /^\d+\.\d+\.\d+$/.test(m.version || ''));
    check('js 文件确实存在', existsSync(join(HERE, m.js || '')));
    check('css 文件确实存在', existsSync(join(HERE, m.css || '')));
} catch (e) {
    check('manifest.json 可解析', false, e.message);
}

console.log('\n' + '='.repeat(50));
console.log(`通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exit(1);
