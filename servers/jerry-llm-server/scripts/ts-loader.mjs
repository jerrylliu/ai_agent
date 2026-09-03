/**
 * ESM loader 注册入口
 *
 * 用法：
 *   node --import ./scripts/ts-loader.mjs --experimental-strip-types scripts/eval/generate-dataset.ts
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(pathToFileURL('./scripts/ts-resolver.mjs').href, pathToFileURL('./'));
