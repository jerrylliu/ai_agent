/**
 * lib/anchor-match.test.ts
 *
 * 引用锚点匹配单元测试（引用定位闭环的容错核心）
 * - normalizeAnchorText: 空白归一化
 * - findAnchorBlockIndex: [60, 40, 25] 长度阶梯的命中 / 降级 / 失配
 *
 * 说明：blockTexts 按契约必须已归一化，故用例中的块文本一律不含空白字符。
 */

import { describe, it, expect } from 'vitest';
import {
  ANCHOR_MATCH_LENGTHS,
  ANCHOR_NOT_FOUND,
  findAnchorBlockIndex,
  normalizeAnchorText,
} from './anchor-match';

describe('lib/anchor-match', () => {
  /* ====================================================================
   * ANCHOR_MATCH_LENGTHS 契约
   * ==================================================================*/
  describe('ANCHOR_MATCH_LENGTHS', () => {
    it('应按从长到短排列（保证长档优先、定位最精确）', () => {
      expect(ANCHOR_MATCH_LENGTHS).toEqual(
        [...ANCHOR_MATCH_LENGTHS].sort((a, b) => b - a),
      );
    });

    it('应至少包含一个档位', () => {
      expect(ANCHOR_MATCH_LENGTHS.length).toBeGreaterThan(0);
    });
  });

  /* ====================================================================
   * normalizeAnchorText
   * ==================================================================*/
  describe('normalizeAnchorText', () => {
    it('应移除换行、制表符与全角空格等全部空白', () => {
      expect(normalizeAnchorText('第一段\n第二段\t末尾\u3000全角')).toBe(
        '第一段第二段末尾全角',
      );
    });

    it('应移除连续空格', () => {
      expect(normalizeAnchorText('a b  c   d')).toBe('abcd');
    });

    it('空字符串应原样返回', () => {
      expect(normalizeAnchorText('')).toBe('');
    });

    it('无空白文本应原样返回', () => {
      expect(normalizeAnchorText('检索增强生成')).toBe('检索增强生成');
    });
  });

  /* ====================================================================
   * findAnchorBlockIndex —— 首档命中
   * ==================================================================*/
  describe('findAnchorBlockIndex 首档（60 字）命中', () => {
    it('应返回锚点所在块的下标', () => {
      const blocks = ['第一块内容', '第二块内容', '目标块内容片段'];
      expect(findAnchorBlockIndex(blocks, '目标块内容片段')).toBe(2);
    });

    it('长档应优先于短档，避免命中前缀相同的干扰块', () => {
      const prefix = 'P'.repeat(25);
      const decoy = `${prefix}DECOY`;
      const target = `${prefix}TARGET${'T'.repeat(50)}`;
      const blocks = [decoy, target];
      // 25 档会误命中 blocks[0]，60 档前缀只存在于 blocks[1]
      expect(findAnchorBlockIndex(blocks, target.slice(0, 75))).toBe(1);
    });

    it('锚点含换行时，归一化后仍应命中无换行的块文本', () => {
      const blocks = ['检索增强的核心价值在于让回答可溯源，避免幻觉。'];
      expect(
        findAnchorBlockIndex(blocks, '检索增强的核心价值在于\n让回答可溯源'),
      ).toBe(0);
    });
  });

  /* ====================================================================
   * findAnchorBlockIndex —— 阶梯降级
   * ==================================================================*/
  describe('findAnchorBlockIndex 阶梯降级', () => {
    it('60 字失配时应降级到 40 档命中', () => {
      const head40 = 'H'.repeat(40);
      const blocks = [head40.slice(0, 30), `${head40}文档实际内容`];
      // 锚点在第 41 字之后与文档不一致（文档被编辑过），60 档必然失配
      const anchor = `${head40}入库时的旧内容${'X'.repeat(30)}`;
      // 返回 1 而非 0：证明用的是 40 档（25 档会命中只含 30 字的 blocks[0]）
      expect(findAnchorBlockIndex(blocks, anchor)).toBe(1);
    });

    it('60/40 字均失配时应降级到 25 档命中', () => {
      const head25 = 'H'.repeat(25);
      const blocks = [head25.slice(0, 24), `${head25}目标段落`];
      const anchor = `${head25}入库时的旧内容${'X'.repeat(40)}`;
      // blocks[0] 只有 24 字，25 档也匹配不上，故命中 blocks[1]
      expect(findAnchorBlockIndex(blocks, anchor)).toBe(1);
    });

    it('锚点归一化后不足 60 字时，阶梯去重不应影响命中', () => {
      const shortAnchor = '知识库检索的命中率提升方案';
      const blocks = ['前言', `第二章${shortAnchor}的具体做法`, '结尾'];
      expect(findAnchorBlockIndex(blocks, shortAnchor)).toBe(1);
    });
  });

  /* ====================================================================
   * findAnchorBlockIndex —— 失配与边界
   * ==================================================================*/
  describe('findAnchorBlockIndex 失配与边界', () => {
    it('全部档位失配时应返回 ANCHOR_NOT_FOUND', () => {
      const blocks = ['完全无关的段落甲', '完全无关的段落乙'];
      expect(findAnchorBlockIndex(blocks, 'Z'.repeat(80))).toBe(ANCHOR_NOT_FOUND);
    });

    it('空锚点应返回 ANCHOR_NOT_FOUND', () => {
      expect(findAnchorBlockIndex(['任意内容'], '')).toBe(ANCHOR_NOT_FOUND);
    });

    it('纯空白锚点应返回 ANCHOR_NOT_FOUND', () => {
      expect(findAnchorBlockIndex(['任意内容'], ' \n\t ')).toBe(ANCHOR_NOT_FOUND);
    });

    it('空文档（无文本块）应返回 ANCHOR_NOT_FOUND', () => {
      expect(findAnchorBlockIndex([], '有效锚点')).toBe(ANCHOR_NOT_FOUND);
    });

    it('块文本未归一化时会失配（契约：调用方必须先归一化）', () => {
      expect(findAnchorBlockIndex(['第一段\n第二段'], '第一段第二段')).toBe(
        ANCHOR_NOT_FOUND,
      );
    });
  });
});
