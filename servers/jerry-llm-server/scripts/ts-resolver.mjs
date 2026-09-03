/**
 * ESM resolver + loader：
 * 1. 将 .js 导入和无扩展名导入解析到 .ts 源文件
 * 2. 为 .ts 文件注入 __dirname / __filename 垫片（CJS 兼容）
 *
 * 解决 Node.js --experimental-transform-types 不支持
 * TypeScript 的 "nodenext" 模块解析规则和 CJS 全局变量的问题。
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  // 只处理相对路径导入
  if (
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  ) {
    const importerDir = dirname(fileURLToPath(context.parentURL));
    const targetPath = pathResolve(importerDir, specifier);

    // 情况 1：以 .js 结尾，且 .js 文件不存在但 .ts 存在
    if (specifier.endsWith('.js')) {
      const tsPath = targetPath.slice(0, -3) + '.ts';
      if (!existsSync(targetPath) && existsSync(tsPath)) {
        return nextResolve(pathToFileURL(tsPath).href, context);
      }
    }

    // 情况 2：无扩展名，尝试 .ts / .tsx / index.ts
    if (!specifier.endsWith('.js') && !specifier.endsWith('.ts') &&
        !specifier.endsWith('.mjs') && !specifier.endsWith('.cjs') &&
        !specifier.endsWith('.json')) {
      const tsPath = targetPath + '.ts';
      const tsxPath = targetPath + '.tsx';
      const indexPath = pathResolve(targetPath, 'index.ts');

      if (existsSync(tsPath)) {
        return nextResolve(pathToFileURL(tsPath).href, context);
      }
      if (existsSync(tsxPath)) {
        return nextResolve(pathToFileURL(tsxPath).href, context);
      }
      if (existsSync(indexPath)) {
        return nextResolve(pathToFileURL(indexPath).href, context);
      }
    }
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);

  // 为 .ts 文件注入 __dirname / __filename 垫片
  if (url.endsWith('.ts') && result.source) {
    const filePath = fileURLToPath(url);
    const fileDir = dirname(filePath);
    const source = result.source.toString();

    // 在文件开头注入 CJS 全局变量
    const shim = `const __filename = ${JSON.stringify(filePath)};\nconst __dirname = ${JSON.stringify(fileDir)};\n`;

    return {
      ...result,
      source: shim + source,
    };
  }

  return result;
}
