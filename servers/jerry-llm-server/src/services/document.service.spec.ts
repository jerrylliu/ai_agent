/**
 * services/document.service.spec.ts
 *
 * DocumentService.diffVersions（版本对比）纯单元测试。
 *
 * 重点覆盖占位文本防护：parseVersionText 在文件丢失/解析失败时的
 * 空串与「[解析失败: ...]」占位文本不得参与 diff 产出误导性结果。
 *
 * mock 策略：与 session.service.spec.ts 一致——mock @nestjs/typeorm 装饰器 +
 * 模拟各 Repository，直接 new 实例构造被测对象；
 * getDocument / parseVersionText 为私有方法，通过实例 spy 控制返回值。
 */

/* =====================================================================
 * Mock 基础模块，防止级联 import 报错
 * ==================================================================*/
jest.mock('../fundamentals/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../fundamentals/config', () => ({
  config: {},
  runtimePaths: { uploads: '/tmp/uploads' },
}));

jest.mock('../fundamentals/file-storage', () => ({
  saveVersionFile: jest.fn(),
  validateFileSize: jest.fn(),
  validateFileType: jest.fn(),
  calculateChecksum: jest.fn(),
  computeContentHash: jest.fn(),
  deleteVersionFile: jest.fn(),
  deleteDocumentFiles: jest.fn(),
  deleteDocumentImageFiles: jest.fn(),
  readVersionFile: jest.fn(),
}));

jest.mock('../fundamentals/document-parser', () => ({
  parseDocument: jest.fn(),
  getMimeType: jest.fn(),
}));

jest.mock('../fundamentals/vector-store', () => ({
  addDocuments: jest.fn(),
  addImageChunks: jest.fn(),
  removeDocumentVersion: jest.fn(),
  updateVersionVectorStatus: jest.fn(),
  reindexVersion: jest.fn(),
  resetVectorStore: jest.fn(),
  isVectorStoreMemoryMode: jest.fn(),
  getActiveCollectionName: jest.fn(),
}));

jest.mock('../fundamentals/vision-translator', () => ({
  translateImagesBatch: jest.fn(),
  loadImageBuffer: jest.fn(),
  persistImageAsset: jest.fn(),
  computeImageHashExport: jest.fn(),
}));

jest.mock('../fundamentals/document-generator', () => ({
  markdownToDocx: jest.fn(),
}));

/* =====================================================================
 * Mock @nestjs/typeorm — InjectRepository 直接返回 mock
 * ==================================================================*/
const mockRepos: Record<string, any> = {};
function getMockRepo(name: string) {
  if (!mockRepos[name]) {
    mockRepos[name] = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      create: jest.fn(),
      increment: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
  }
  return mockRepos[name];
}

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => (target: any, key: string, index: number) => {},
  getRepositoryToken: () => 'mockRepo',
}));

/* =====================================================================
 * 导入被测模块
 * ==================================================================*/
import { DocumentService } from './document.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

const mockDataSource = { transaction: jest.fn(), query: jest.fn() };

describe('DocumentService.diffVersions', () => {
  function createService() {
    return new DocumentService(
      getMockRepo('document'),
      getMockRepo('version'),
      getMockRepo('auditLog'),
      getMockRepo('pendingVectorOp'),
      getMockRepo('imageDescription'),
      mockDataSource as any,
    );
  }

  function makeVersion(id: number, versionNumber: number): any {
    return {
      id,
      documentId: 1,
      versionNumber,
      fileUrl: `documents/1/v${versionNumber}/document.txt`,
      fileType: 'txt',
      status: 'active',
    };
  }

  function setupVersions(service: DocumentService, v1: any, v2: any | null) {
    (getMockRepo('version').findOne as jest.Mock).mockImplementation(
      (args: any) => {
        if (args.where.id === v1.id) return Promise.resolve(v1);
        if (v2 && args.where.id === v2.id) return Promise.resolve(v2);
        return Promise.resolve(null);
      },
    );
    jest
      .spyOn(service as any, 'getDocument')
      .mockResolvedValue({ id: 1, title: '测试文档' });
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('版本不存在时抛 NotFoundException', async () => {
    const service = createService();
    const v1 = makeVersion(101, 1);
    setupVersions(service, v1, null);

    await expect(service.diffVersions(1, 101, 999)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('正常对比：返回行级 diff 且包含 added/removed 标记', async () => {
    const service = createService();
    const v1 = makeVersion(101, 1);
    const v2 = makeVersion(102, 2);
    setupVersions(service, v1, v2);
    jest
      .spyOn(service as any, 'parseVersionText')
      .mockImplementation((v: any) =>
        Promise.resolve(
          v.id === 101 ? '第一行A\n第二行共' : '第一行B\n第二行共',
        ),
      );

    const changes = await service.diffVersions(1, 101, 102);

    expect(changes.length).toBeGreaterThan(0);
    // diffLines 的 value 保留行尾换行符
    const flattened = changes.map((c) => ({
      v: c.value,
      a: !!c.added,
      r: !!c.removed,
    }));
    expect(flattened).toContainEqual({ v: '第一行A\n', a: false, r: true });
    expect(flattened).toContainEqual({ v: '第一行B\n', a: true, r: false });
    expect(flattened).toContainEqual({ v: '第二行共', a: false, r: false });
  });

  it('占位文本防护：解析失败占位文本必须中止对比并抛业务异常，而非产出假 diff', async () => {
    const service = createService();
    const v1 = makeVersion(101, 1);
    const v2 = makeVersion(102, 2);
    setupVersions(service, v1, v2);
    jest
      .spyOn(service as any, 'parseVersionText')
      .mockImplementation((v: any) =>
        Promise.resolve(
          v.id === 101 ? '[解析失败: 文件损坏]' : '第二版的正常内容',
        ),
      );

    await expect(service.diffVersions(1, 101, 102)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.diffVersions(1, 101, 102)).rejects.toThrow(
      /v1.*解析失败/,
    );
  });

  it('占位文本防护：文件丢失（空文本）必须中止对比并指明具体版本', async () => {
    const service = createService();
    const v1 = makeVersion(101, 1);
    const v2 = makeVersion(102, 2);
    setupVersions(service, v1, v2);
    jest
      .spyOn(service as any, 'parseVersionText')
      .mockImplementation((v: any) =>
        Promise.resolve(v.id === 102 ? '' : '第一版正常内容'),
      );

    await expect(service.diffVersions(1, 101, 102)).rejects.toThrow(
      /v2.*丢失或内容为空/,
    );
  });
});
