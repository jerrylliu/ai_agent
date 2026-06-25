// 注入测试环境变量，避免 config 启动校验失败
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockUploadImage = jest.fn();
const mockUploadFile = jest.fn();
const mockSendImageMessage = jest.fn();
const mockSendFileMessage = jest.fn();
const mockChartPng = jest.fn();
const mockMindmapPng = jest.fn();

jest.mock('../feishu-notify.service.js', () => ({
  uploadImage: (...a: unknown[]) => mockUploadImage(...a),
  uploadFile: (...a: unknown[]) => mockUploadFile(...a),
  sendImageMessage: (...a: unknown[]) => mockSendImageMessage(...a),
  sendFileMessage: (...a: unknown[]) => mockSendFileMessage(...a),
}));

// Redis 不可用：走本地降级去重（每个用例前 __resetDocSentForTest 清空）
jest.mock('../redis-client.js', () => ({
  getRedis: () => null,
  isRedisReady: () => false,
}));

import {
  extractRichAssets,
  syncRichAssetsToFeishu,
  __setRenderersForTest,
  __resetDocSentForTest,
} from './feishu-asset-sync';

const PNG_DATA_URI = 'data:image/png;base64,aGVsbG8='; // "hello"

describe('feishu-asset-sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetDocSentForTest();
    mockUploadImage.mockResolvedValue({ success: true, key: 'img_key' });
    mockUploadFile.mockResolvedValue({ success: true, key: 'file_key' });
    mockSendImageMessage.mockResolvedValue({ success: true, messageId: 'm1' });
    mockSendFileMessage.mockResolvedValue({ success: true, messageId: 'm2' });
    mockChartPng.mockResolvedValue(PNG_DATA_URI);
    mockMindmapPng.mockResolvedValue(PNG_DATA_URI);
    // 注入渲染器，避免动态 import puppeteer（ESM）拖垮单测
    __setRenderersForTest({
      chartPngDataUri: (...a: unknown[]) => mockChartPng(...a),
      mindmapPngDataUri: (...a: unknown[]) => mockMindmapPng(...a),
    });
  });

  afterAll(() => {
    __setRenderersForTest(null);
  });

  describe('extractRichAssets', () => {
    it('应提取 echarts 代码块并从文本剥离', () => {
      const content = '看图：\n```echarts\n{"a":1}\n```\n说明文字';
      const r = extractRichAssets(content);
      expect(r.charts).toEqual(['{"a":1}']);
      expect(r.text).not.toContain('echarts');
      expect(r.text).toContain('说明文字');
    });

    it('应提取 mermaid 代码块并从文本剥离', () => {
      const content = '思维导图：\n```mermaid\nmindmap\n  root((x))\n```\n结束';
      const r = extractRichAssets(content);
      expect(r.mindmaps).toHaveLength(1);
      expect(r.mindmaps[0]).toContain('mindmap');
      expect(r.text).not.toContain('mermaid');
    });

    it('无富产物时原样返回文本', () => {
      const r = extractRichAssets('纯文本回复');
      expect(r.charts).toEqual([]);
      expect(r.mindmaps).toEqual([]);
      expect(r.text).toBe('纯文本回复');
    });
  });

  describe('syncRichAssetsToFeishu', () => {
    it('图表应渲染 PNG 并以原生 image 消息发送（单聊 open_id）', async () => {
      await syncRichAssetsToFeishu({
        receiveId: 'ou_1',
        receiveIdType: 'open_id',
        charts: ['{"series":[]}'],
        mindmaps: [],
        documents: [],
        idempotencyBase: 'base1',
        sessionId: 's1',
      });

      expect(mockChartPng).toHaveBeenCalledTimes(1);
      expect(mockUploadImage).toHaveBeenCalledWith('', expect.any(Buffer));
      expect(mockSendImageMessage).toHaveBeenCalledWith('ou_1', 'open_id', 'img_key', expect.any(String));
    });

    it('思维导图应渲染 PNG 并以原生 image 消息发送（群聊 chat_id）', async () => {
      await syncRichAssetsToFeishu({
        receiveId: 'oc_1',
        receiveIdType: 'chat_id',
        charts: [],
        mindmaps: ['mindmap\n  root((x))'],
        documents: [],
        idempotencyBase: 'base2',
        sessionId: 's1',
      });

      expect(mockMindmapPng).toHaveBeenCalledTimes(1);
      expect(mockSendImageMessage).toHaveBeenCalledWith('oc_1', 'chat_id', 'img_key', expect.any(String));
    });

    it('文档应上传并以原生 file 消息发送', async () => {
      await syncRichAssetsToFeishu({
        receiveId: 'oc_1',
        receiveIdType: 'chat_id',
        charts: [],
        mindmaps: [],
        documents: [{ key: 'doc_k', filename: '科技.pdf', buffer: Buffer.from('pdf') }],
        idempotencyBase: 'base3',
        sessionId: 's1',
      });

      expect(mockUploadFile).toHaveBeenCalledWith('fc://document/doc_k', '科技.pdf', expect.any(Buffer));
      expect(mockSendFileMessage).toHaveBeenCalledWith('oc_1', 'chat_id', 'file_key', expect.any(String));
    });

    it('同一会话同一文档只同步一次（去重，防时间窗口重复发）', async () => {
      const doc = { key: 'doc_dup', filename: '报告.pdf', buffer: Buffer.from('pdf') };
      const params = {
        receiveId: 'oc_1', receiveIdType: 'chat_id' as const,
        charts: [], mindmaps: [], documents: [doc],
        idempotencyBase: 'b', sessionId: 's_dup',
      };
      await syncRichAssetsToFeishu(params);
      await syncRichAssetsToFeishu(params); // 第二次（模拟 10 分钟窗口内再次触发）

      expect(mockUploadFile).toHaveBeenCalledTimes(1);
      expect(mockSendFileMessage).toHaveBeenCalledTimes(1);
    });

    it('PNG 渲染失败时跳过该图表，不抛错', async () => {
      mockChartPng.mockResolvedValue(null);
      await expect(
        syncRichAssetsToFeishu({
          receiveId: 'ou_1',
          receiveIdType: 'open_id',
          charts: ['{"a":1}'],
          mindmaps: [],
          documents: [],
          idempotencyBase: 'base4',
          sessionId: 's1',
        }),
      ).resolves.toBeUndefined();
      expect(mockSendImageMessage).not.toHaveBeenCalled();
    });

    it('同一 idempotencyBase 派生稳定 uuid（重复调用 uuid 一致）', async () => {
      await syncRichAssetsToFeishu({
        receiveId: 'ou_1', receiveIdType: 'open_id',
        charts: ['{"a":1}'], mindmaps: [], documents: [],
        idempotencyBase: 'fixed', sessionId: 's1',
      });
      const firstUuid = mockSendImageMessage.mock.calls[0][3];
      jest.clearAllMocks();
      mockUploadImage.mockResolvedValue({ success: true, key: 'img_key' });
      mockSendImageMessage.mockResolvedValue({ success: true, messageId: 'm1' });
      mockChartPng.mockResolvedValue(PNG_DATA_URI);
      await syncRichAssetsToFeishu({
        receiveId: 'ou_1', receiveIdType: 'open_id',
        charts: ['{"a":1}'], mindmaps: [], documents: [],
        idempotencyBase: 'fixed', sessionId: 's1',
      });
      expect(mockSendImageMessage.mock.calls[0][3]).toBe(firstUuid);
    });
  });
});
