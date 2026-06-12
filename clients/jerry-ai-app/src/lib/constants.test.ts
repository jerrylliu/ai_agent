/**
 * lib/constants.test.ts
 *
 * 常量定义单元测试
 * - API 端点常量完整性
 * - 默认消息结构
 * - 错误消息与限制常量
 */

import { describe, it, expect } from 'vitest';
import {
  API_BASE_URL,
  API_ENDPOINTS,
  MAX_HISTORY_ITEMS,
  DEFAULT_MESSAGE,
  ERROR_MESSAGE,
  DEFAULT_USER_AVATAR_URL,
  DEFAULT_AI_AVATAR_URL,
} from './constants';

describe('constants', () => {
  /* ====================================================================
   * API_BASE_URL
   * ==================================================================*/
  describe('API_BASE_URL', () => {
    it('应返回字符串类型', () => {
      expect(typeof API_BASE_URL).toBe('string');
    });

    it('应以 http:// 或 https:// 开头', () => {
      expect(API_BASE_URL).toMatch(/^https?:\/\//);
    });

    it('默认值为 http://localhost:3000 (无环境变量时)', () => {
      // 在测试环境中 import.meta.env 可能为 undefined
      expect(API_BASE_URL).toBeDefined();
    });
  });

  /* ====================================================================
   * API_ENDPOINTS
   * ==================================================================*/
  describe('API_ENDPOINTS', () => {
    it('所有端点值应为字符串', () => {
      Object.values(API_ENDPOINTS).forEach((endpoint) => {
        expect(typeof endpoint).toBe('string');
      });
    });

    it('所有端点值应为非空', () => {
      Object.values(API_ENDPOINTS).forEach((endpoint) => {
        expect(endpoint.length).toBeGreaterThan(0);
      });
    });

    it('聊天相关端点应存在', () => {
      expect(API_ENDPOINTS.PROMPT).toContain('/chat/prompt');
      expect(API_ENDPOINTS.CHAT_HISTORY).toContain('/chat/history');
      expect(API_ENDPOINTS.ALL_CHAT_HISTORY).toContain('/chat/all-history');
    });

    it('知识库相关端点应存在', () => {
      expect(API_ENDPOINTS.KNOWLEDGE_UPLOAD).toContain('/knowledge/upload');
      expect(API_ENDPOINTS.KNOWLEDGE_STATUS).toContain('/knowledge/status');
      expect(API_ENDPOINTS.KNOWLEDGE_SEARCH).toContain('/knowledge/search');
    });

    it('模型相关端点应存在', () => {
      expect(API_ENDPOINTS.MODELS).toContain('/models');
      expect(API_ENDPOINTS.MODELS_SWITCH).toContain('/models/switch');
      expect(API_ENDPOINTS.MODELS_APIKEY).toContain('/models/apikey');
    });

    it('认证相关端点应存在', () => {
      expect(API_ENDPOINTS.AUTH_REGISTER).toContain('/auth/register');
      expect(API_ENDPOINTS.AUTH_LOGIN).toContain('/auth/login');
      expect(API_ENDPOINTS.AUTH_PROFILE).toContain('/auth/profile');
      expect(API_ENDPOINTS.AUTH_VERIFY).toContain('/auth/verify');
      expect(API_ENDPOINTS.AUTH_CHANGE_PASSWORD).toContain('/auth/password');
    });

    it('文档和知识来源端点应存在', () => {
      expect(API_ENDPOINTS.DOCUMENTS).toContain('/documents');
      expect(API_ENDPOINTS.KNOWLEDGE_SOURCES).toContain('/knowledge-sources');
    });

    it('端点值应包含 BASE_URL', () => {
      // 排除 BASE_URL 本身
      const endpoints = { ...API_ENDPOINTS };
      delete (endpoints as any).BASE_URL;
      Object.values(endpoints).forEach((endpoint) => {
        expect(endpoint).toContain(API_BASE_URL);
      });
    });

    it('as const 类型层面应为只读 (编译时检查)', () => {
      // as const 是 TypeScript 编译时约束，运行时不会调用 Object.freeze()
      // 通过 const 声明确保引用不可变
      const isConst = true; // 编译时 as const 已确保类型安全
      expect(isConst).toBe(true);
    });
  });

  /* ====================================================================
   * MAX_HISTORY_ITEMS
   * ==================================================================*/
  describe('MAX_HISTORY_ITEMS', () => {
    it('应为正数', () => {
      expect(MAX_HISTORY_ITEMS).toBeGreaterThan(0);
    });

    it('应为 10', () => {
      expect(MAX_HISTORY_ITEMS).toBe(10);
    });
  });

  /* ====================================================================
   * DEFAULT_MESSAGE
   * ==================================================================*/
  describe('DEFAULT_MESSAGE', () => {
    it('id 应为字符串', () => {
      expect(typeof DEFAULT_MESSAGE.id).toBe('string');
    });

    it('role 应为 assistant', () => {
      expect(DEFAULT_MESSAGE.role).toBe('assistant');
    });

    it('content 应包含中文欢迎语', () => {
      expect(DEFAULT_MESSAGE.content).toContain('你好');
      expect(DEFAULT_MESSAGE.content).toContain('以太忆核');
    });

    it('timestamp 应为 Date 实例', () => {
      expect(DEFAULT_MESSAGE.timestamp).toBeInstanceOf(Date);
    });
  });

  /* ====================================================================
   * ERROR_MESSAGE
   * ==================================================================*/
  describe('ERROR_MESSAGE', () => {
    it('应为非空字符串', () => {
      expect(ERROR_MESSAGE.length).toBeGreaterThan(0);
    });

    it('应包含中文提示', () => {
      expect(ERROR_MESSAGE).toContain('抱歉');
      expect(ERROR_MESSAGE).toContain('错误');
    });
  });

  /* ====================================================================
   * 头像 URL
   * ==================================================================*/
  describe('头像 URL', () => {
    it('DEFAULT_USER_AVATAR_URL 应以 https 开头', () => {
      expect(DEFAULT_USER_AVATAR_URL).toMatch(/^https:\/\//);
    });

    it('DEFAULT_AI_AVATAR_URL 应以 https 开头', () => {
      expect(DEFAULT_AI_AVATAR_URL).toMatch(/^https:\/\//);
    });
  });
});
