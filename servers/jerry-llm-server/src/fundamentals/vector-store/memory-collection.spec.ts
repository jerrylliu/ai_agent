/**
 * 记忆向量检索改造 — 纯函数单元测试
 *
 * 覆盖 memory-vector-retrieval-plan.md §11 测试计划中可离线验证的部分：
 * - 类别守护（guardCategory / guardExtractedMemories，§4.5）
 * - 三路合并 + Token 预算（mergeWithBudget，§5.3）
 */

import {
  guardCategory,
  guardExtractedMemories,
  BUILTIN_MEMORY_CATEGORIES,
} from '../memory-extractor';
import { mergeWithBudget, type MemoryInjectItem } from '../../services/memory.service';

// ==================== 类别守护 ====================

describe('guardCategory', () => {
  it('内置类别原样通过', () => {
    for (const c of BUILTIN_MEMORY_CATEGORIES) {
      expect(guardCategory(c)).toBe(c);
    }
  });

  it('大小写/空白变体归并到内置类别', () => {
    expect(guardCategory('  Fact ')).toBe('fact');
    expect(guardCategory('SKILL')).toBe('skill');
  });

  it('中文同义词归并', () => {
    expect(guardCategory('偏好')).toBe('preference');
    expect(guardCategory('技能')).toBe('skill');
    expect(guardCategory('背景')).toBe('context');
  });

  it('新类别按 slug 规则接受（受控扩展）', () => {
    expect(guardCategory('hobby')).toBe('hobby');
    expect(guardCategory('relationship')).toBe('relationship');
    expect(guardCategory('理财习惯')).toBe('理财习惯');
  });

  it('格式污染被拒绝（返回 null）', () => {
    expect(guardCategory('')).toBeNull();
    expect(guardCategory('   ')).toBeNull();
    expect(guardCategory('偏好 2!')).toBeNull(); // 含空格与符号
    expect(guardCategory('a'.repeat(25))).toBeNull(); // 超长
    expect(guardCategory(123)).toBeNull();
    expect(guardCategory(null)).toBeNull();
    expect(guardCategory(undefined)).toBeNull();
  });
});

describe('guardExtractedMemories', () => {
  it('无效类别回退 fact 且保留内容（内容比分类重要）', () => {
    const result = guardExtractedMemories([
      { content: '用户是前端开发者', category: 'Invalid Cat!', importance: 5 },
      { content: '用户喜欢暗色主题', category: '偏好', importance: 4 },
    ]);
    expect(result[0]).toEqual({
      content: '用户是前端开发者',
      category: 'fact',
      importance: 5,
    });
    expect(result[1].category).toBe('preference');
  });
});

// ==================== 三路合并 + Token 预算 ====================

describe('mergeWithBudget', () => {
  const core: MemoryInjectItem[] = [
    { id: 1, content: '用户的QQ邮箱是a@qq.com' }, // ~14 token
  ];
  const vector: MemoryInjectItem[] = [
    { id: 2, content: 'a'.repeat(150) }, // 100 token
    { id: 3, content: 'b'.repeat(150) }, // 100 token
  ];
  const fallback: MemoryInjectItem[] = [
    { id: -1, content: 'c'.repeat(300) }, // 200 token
    { id: -2, content: 'd'.repeat(300) }, // 200 token
  ];

  it('三路按优先级合并，超预算按 ①→②→③ 截断', () => {
    // 预算 300：核心 14 + 检索 100 + 检索 100 + 兜底第一条放不下(200) → 截断
    const merged = mergeWithBudget([core, vector, fallback], 300);
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('预算充足时三路全部保留', () => {
    const merged = mergeWithBudget([core, vector, fallback], 10000);
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3, -1, -2]);
  });

  it('重复 id 去重：向量层命中的核心层记忆不重复注入', () => {
    const overlapVector: MemoryInjectItem[] = [
      { id: 1, content: '用户的QQ邮箱是a@qq.com' }, // 与核心层同一条
      { id: 2, content: 'x'.repeat(100) },
    ];
    const merged = mergeWithBudget([core, overlapVector, []], 10000);
    expect(merged.map((m) => m.id)).toEqual([1, 2]);
  });

  it('极小预算下核心层也遵守预算（但优先占用）', () => {
    const merged = mergeWithBudget([core, vector, fallback], 20);
    expect(merged.map((m) => m.id)).toEqual([1]);
  });

  it('空层不报错', () => {
    expect(mergeWithBudget([[], [], []], 100)).toEqual([]);
  });
});
