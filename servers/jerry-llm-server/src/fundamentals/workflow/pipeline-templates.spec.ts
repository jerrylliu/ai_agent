/**
 * fundamentals/workflow/pipeline-templates.spec.ts
 *
 * Pipeline 模板库单元测试
 * 覆盖：getPipelineTemplate / listPipelineTemplates / hasPipelineTemplate
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  getPipelineTemplate,
  listPipelineTemplates,
  hasPipelineTemplate,
} from './pipeline-templates';

describe('Pipeline 模板库', () => {
  describe('listPipelineTemplates', () => {
    it('应返回 4 个预置模板的清单', () => {
      const templates = listPipelineTemplates();
      expect(templates).toHaveLength(4);
    });

    it('每个模板应包含 id/name/description', () => {
      const templates = listPipelineTemplates();
      for (const t of templates) {
        expect(t).toHaveProperty('id');
        expect(t).toHaveProperty('name');
        expect(t).toHaveProperty('description');
        expect(typeof t.id).toBe('string');
        expect(typeof t.name).toBe('string');
      }
    });

    it('应包含 search_kb_and_chart 模板', () => {
      const ids = listPipelineTemplates().map(t => t.id);
      expect(ids).toContain('search_kb_and_chart');
    });

    it('应包含 web_search_and_document 模板', () => {
      const ids = listPipelineTemplates().map(t => t.id);
      expect(ids).toContain('web_search_and_document');
    });
  });

  describe('hasPipelineTemplate', () => {
    it('存在的模板应返回 true', () => {
      expect(hasPipelineTemplate('search_kb_and_chart')).toBe(true);
      expect(hasPipelineTemplate('web_search_and_document')).toBe(true);
    });

    it('不存在的模板应返回 false', () => {
      expect(hasPipelineTemplate('nonexistent')).toBe(false);
    });

    it('空字符串应返回 false', () => {
      expect(hasPipelineTemplate('')).toBe(false);
    });
  });

  describe('getPipelineTemplate', () => {
    it('应返回模板定义（含 steps）', () => {
      const tpl = getPipelineTemplate('search_kb_and_chart');
      expect(tpl).toBeDefined();
      expect(tpl!.id).toBe('search_kb_and_chart');
      expect(tpl!.steps.length).toBeGreaterThanOrEqual(1);
    });

    it('每个 step 应包含 id/tool/params', () => {
      const tpl = getPipelineTemplate('web_search_and_mindmap')!;
      for (const step of tpl.steps) {
        expect(step).toHaveProperty('id');
        expect(step).toHaveProperty('tool');
        expect(step).toHaveProperty('params');
      }
    });

    it('不存在的模板应返回 undefined', () => {
      expect(getPipelineTemplate('ghost')).toBeUndefined();
    });
  });
});
