/**
 * node-sql-parser 的 CJS 互操作垫片
 *
 * 为什么需要：node-sql-parser 是 CJS 包，其命名导出（Parser 等）无法被 Node
 * ESM 的 cjs-module-lexer 静态检测，`import { Parser } from 'node-sql-parser'`
 * 在 --experimental-transform-types 的纯 ESM 加载下直接抛 SyntaxError。
 * 生产链路（nest build / dist）不受影响——本垫片只被 scripts/ts-resolver.mjs
 * 重定向使用（见 resolve() 中的 bare specifier 拦截）。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('node-sql-parser');

export default mod;
export const Parser = mod.Parser;
