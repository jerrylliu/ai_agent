import TurndownService from 'turndown';
import { logger } from './logger';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript']);

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const LARK_API_BASE = 'https://open.larksuite.com/open-apis';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_PAGES = 100;

export interface FeishuPage {
  id: string;
  title: string;
  markdown: string;
  url: string;
  updatedAt: string;
  objType: string;
}

export interface FeishuFetchResult {
  pages: FeishuPage[];
  totalPages: number;
  errors: Array<{ id: string; error: string }>;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  wikiSpaceId?: string;
  docToken?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  maxPages?: number;
  feishuDomain?: string;
}

const tokenCacheMap = new Map<string, { token: string; expiresAt: number }>();

function getApiBase(feishuDomain?: string): string {
  if (!feishuDomain) return FEISHU_API_BASE;
  const domain = feishuDomain.toLowerCase();
  if (domain.includes('larksuite') || domain.includes('lark')) {
    return LARK_API_BASE;
  }
  return FEISHU_API_BASE;
}

function getWikiBaseUrl(feishuDomain?: string): string {
  if (!feishuDomain) return 'https://feishu.cn';
  if (feishuDomain.startsWith('http://') || feishuDomain.startsWith('https://')) {
    return feishuDomain;
  }
  return `https://${feishuDomain}`;
}

async function getTenantAccessToken(appId: string, appSecret: string, apiBase: string): Promise<string> {
  const cacheKey = `${apiBase}:${appId}`;
  const cached = tokenCacheMap.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${apiBase}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: abortController.signal,
    });

    const data = await response.json();

    if (data.code !== 0) {
      throw new Error(`飞书获取 tenant_access_token 失败: ${data.msg}`);
    }

    tokenCacheMap.set(cacheKey, {
      token: data.tenant_access_token,
      expiresAt: Date.now() + (data.expire - 300) * 1000,
    });

    return data.tenant_access_token;
  } catch (error: any) {
    const isTimeout = error.name === 'AbortError';
    const detail = isTimeout ? '请求超时' : (error.cause?.code || error.cause?.message || error.message);
    logger.error('飞书获取 tenant_access_token 网络请求失败', {
      module: 'FeishuConnector',
      apiBase,
      error: detail,
      errorName: error.name,
      causeCode: error.cause?.code,
      causeMessage: error.cause?.message,
    });
    throw new Error(`飞书网络请求失败 (${detail})，请检查网络连接`);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function feishuFetch(path: string, token: string, apiBase: string, method: string = 'GET', body?: any): Promise<any> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const options: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: abortController.signal,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${apiBase}${path}`, options);

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      logger.warn('飞书 API 返回非 JSON 响应', { module: 'FeishuConnector', path, status: response.status, contentType, bodyPreview: text.substring(0, 200) });
      throw new Error(`飞书 API 返回非 JSON 响应 (HTTP ${response.status}): ${text.substring(0, 100)}`);
    }

    const data = await response.json();

    if (data.code !== 0) {
      throw new Error(`飞书 API 错误 (${data.code}): ${data.msg}`);
    }

    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWikiNodes(token: string, spaceId: string, maxPages: number, apiBase: string): Promise<any[]> {
  const allNodes: any[] = [];
  const visitedNodeTokens = new Set<string>();

  async function fetchChildNodes(parentNodeToken?: string): Promise<void> {
    if (allNodes.length >= maxPages) return;

    let pageToken: string | undefined;

    while (allNodes.length < maxPages) {
      let path = `/wiki/v2/spaces/${spaceId}/nodes?limit=50`;
      if (parentNodeToken) {
        path += `&parent_node_token=${parentNodeToken}`;
      }
      if (pageToken) {
        path += `&page_token=${pageToken}`;
      }

      const response = await feishuFetch(path, token, apiBase);
      const nodes = response.data?.items || [];

      for (const node of nodes) {
        if (allNodes.length >= maxPages) break;
        const nodeToken = node.node_token || node.obj_token;
        if (!nodeToken || visitedNodeTokens.has(nodeToken)) continue;
        visitedNodeTokens.add(nodeToken);
        allNodes.push(node);

        if (node.has_child) {
          await new Promise(resolve => setTimeout(resolve, 100));
          await fetchChildNodes(nodeToken);
        }
      }

      if (!response.data?.has_more) break;
      pageToken = response.data?.page_token;
    }
  }

  await fetchChildNodes();

  return allNodes.slice(0, maxPages);
}

async function fetchDocRawContent(token: string, documentId: string, apiBase: string): Promise<string> {
  try {
    const response = await feishuFetch(`/docx/v1/documents/${documentId}/raw_content`, token, apiBase);
    const content = response.data?.content || '';
    logger.info('飞书 docx raw_content 获取结果', { module: 'FeishuConnector', documentId, contentLength: content.length, preview: content.substring(0, 100) });
    return content;
  } catch (error: any) {
    logger.warn('飞书 docx raw_content 获取失败', { module: 'FeishuConnector', documentId, error: error.message });
    return '';
  }
}

async function fetchOldDocRawContent(token: string, documentId: string, apiBase: string): Promise<string> {
  try {
    const response = await feishuFetch(`/doc/v2/documents/${documentId}/raw_content`, token, apiBase);
    const content = response.data?.content || '';
    logger.info('飞书旧版 doc raw_content 获取结果', { module: 'FeishuConnector', documentId, contentLength: content.length, preview: content.substring(0, 100) });
    return content;
  } catch (error: any) {
    logger.warn('飞书旧版 doc raw_content 获取失败', { module: 'FeishuConnector', documentId, error: error.message });
    return '';
  }
}

async function fetchDocContent(token: string, documentId: string, objType: string, apiBase: string): Promise<string> {
  if (objType === 'doc') {
    const rawContent = await fetchOldDocRawContent(token, documentId, apiBase);
    if (rawContent && rawContent.trim().length > 20) {
      return rawContent;
    }
    logger.warn('飞书旧版 doc 内容为空或过短，尝试 docx 方式', { module: 'FeishuConnector', documentId, rawContentLength: rawContent.length });
  }

  const rawContent = await fetchDocRawContent(token, documentId, apiBase);
  if (rawContent && rawContent.trim().length > 20) {
    return rawContent;
  }

  try {
    const response = await feishuFetch(`/docx/v1/documents/${documentId}?expand=body`, token, apiBase);
    const body = response.data?.document?.body;
    if (body) {
      const md = blocksToMarkdown(body);
      logger.info('飞书 docx body 转换结果', { module: 'FeishuConnector', documentId, contentLength: md.length, preview: md.substring(0, 100) });
      return md;
    }
  } catch (error: any) {
    logger.warn('飞书 docx body 获取失败', { module: 'FeishuConnector', documentId, error: error.message });
  }

  return '';
}

const TEXT_FILE_EXTENSIONS = ['.md', '.txt', '.markdown', '.json', '.yaml', '.yml', '.xml', '.csv', '.log', '.ini', '.conf', '.cfg', '.toml', '.env', '.sh', '.bat', '.ps1', '.py', '.js', '.ts', '.jsx', '.tsx', '.css', '.html', '.sql', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.rb', '.php', '.swift', '.kt'];

function isTextFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return TEXT_FILE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

async function fetchFileContent(token: string, fileToken: string, title: string, apiBase: string): Promise<string> {
  try {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 30000);

    try {
      const response = await fetch(`${apiBase}/drive/v1/files/${fileToken}/download`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`文件下载失败: HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      const fileName = title || 'unknown_file';

      logger.info('飞书文件下载响应', { module: 'FeishuConnector', fileToken, fileName, contentType, contentLength: response.headers.get('content-length') });

      if (!isTextFile(fileName) && !contentType.includes('text/') && !contentType.includes('markdown')) {
        return `[非文本文件(${contentType})，暂不支持内容提取: ${fileName}]`;
      }

      const buffer = await response.arrayBuffer();
      const content = Buffer.from(buffer).toString('utf-8');

      logger.info('飞书文件下载成功', { module: 'FeishuConnector', fileToken, fileName, contentLength: content.length, preview: content.substring(0, 100) });
      return content;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error: any) {
    logger.warn('飞书文件内容获取失败', { module: 'FeishuConnector', fileToken, error: error.message });
    return '';
  }
}

async function fetchNodeContent(token: string, objToken: string, objType: string, apiBase: string): Promise<string> {
  if (objType === 'doc' || objType === 'docx') {
    return fetchDocContent(token, objToken, objType, apiBase);
  } else if (objType === 'sheet') {
    return '';
  } else if (objType === 'bitable') {
    return '';
  } else if (objType === 'file') {
    return fetchFileContent(token, objToken, '', apiBase);
  }
  return '';
}

async function fetchWikiContent(token: string, wikiToken: string, apiBase: string): Promise<{ title: string; content: string; objType: string }> {
  try {
    const nodeInfo = await feishuFetch(`/wiki/v2/spaces/get_node?token=${wikiToken}`, token, apiBase);
    const node = nodeInfo.data?.node;
    const objType = node?.obj_type || 'doc';
    const title = node?.title || '无标题';
    const objToken = node?.obj_token || wikiToken;

    logger.info('飞书 Wiki 节点信息', { module: 'FeishuConnector', wikiToken, objType, objToken, title: title.substring(0, 50) });

    let content = '';

    if (objType === 'doc' || objType === 'docx') {
      content = await fetchDocContent(token, objToken, objType, apiBase);
    } else if (objType === 'sheet') {
      content = `[飞书表格，暂不支持内容提取: ${title}]`;
    } else if (objType === 'bitable') {
      content = `[飞书多维表格，暂不支持内容提取: ${title}]`;
    } else if (objType === 'file') {
      content = await fetchFileContent(token, objToken, title, apiBase);
    } else {
      content = `[不支持的飞书对象类型: ${objType}]`;
    }

    return { title, content, objType };
  } catch (error: any) {
    throw new Error(`获取飞书 Wiki 节点内容失败: ${error.message}`);
  }
}

async function fetchDocChildNodes(token: string, docToken: string, maxPages: number, apiBase: string): Promise<Array<{ nodeToken: string; title: string; objType: string; objToken: string }>> {
  const nodeInfo = await feishuFetch(`/wiki/v2/spaces/get_node?token=${docToken}`, token, apiBase);
  const node = nodeInfo.data?.node;
  const spaceId = node?.space_id;
  const parentNodeToken = node?.node_token || docToken;

  const result: Array<{ nodeToken: string; title: string; objType: string; objToken: string }> = [];
  result.push({
    nodeToken: parentNodeToken,
    title: node?.title || '无标题',
    objType: node?.obj_type || 'doc',
    objToken: node?.obj_token || docToken,
  });

  if (!spaceId) {
    logger.warn('飞书文档未关联知识空间，无法获取子节点', { module: 'FeishuConnector', docToken });
    return result;
  }

  const visitedNodeTokens = new Set<string>([parentNodeToken]);

  async function fetchChildren(parentToken: string): Promise<void> {
    if (result.length >= maxPages) return;

    let pageToken: string | undefined;

    while (result.length < maxPages) {
      let path = `/wiki/v2/spaces/${spaceId}/nodes?limit=50&parent_node_token=${parentToken}`;
      if (pageToken) {
        path += `&page_token=${pageToken}`;
      }

      const response = await feishuFetch(path, token, apiBase);
      const items = response.data?.items || [];

      for (const item of items) {
        if (result.length >= maxPages) break;
        const itemNodeToken = item.node_token || item.obj_token;
        if (!itemNodeToken || visitedNodeTokens.has(itemNodeToken)) continue;
        visitedNodeTokens.add(itemNodeToken);
        result.push({
          nodeToken: itemNodeToken,
          title: item.title || '无标题',
          objType: item.obj_type || 'doc',
          objToken: item.obj_token || itemNodeToken,
        });

        if (item.has_child) {
          await new Promise(resolve => setTimeout(resolve, 100));
          await fetchChildren(itemNodeToken);
        }
      }

      if (!response.data?.has_more) break;
      pageToken = response.data?.page_token;
    }
  }

  await fetchChildren(parentNodeToken);

  return result.slice(0, maxPages);
}

function blocksToMarkdown(body: any): string {
  if (!body || !body.blocks) return '';

  const lines: string[] = [];
  for (const block of body.blocks) {
    const text = extractBlockText(block);
    if (!text) continue;

    switch (block.block_type) {
      case 1:
        lines.push(`# ${text}\n`);
        break;
      case 2:
        lines.push(`## ${text}\n`);
        break;
      case 3:
        lines.push(`### ${text}\n`);
        break;
      case 4:
        lines.push(`${text}\n`);
        break;
      case 5:
        lines.push(`- ${text}`);
        break;
      case 6:
        lines.push(`1. ${text}`);
        break;
      case 7:
        lines.push(`- [ ] ${text}`);
        break;
      case 8:
        lines.push(`- [x] ${text}`);
        break;
      case 9:
        lines.push(`\`\`\`\n${text}\n\`\`\`\n`);
        break;
      case 10:
        lines.push(`> ${text}\n`);
        break;
      case 14:
        lines.push(`---\n`);
        break;
      default:
        if (text) lines.push(`${text}\n`);
    }
  }

  return lines.join('\n');
}

function extractBlockText(block: any): string {
  if (!block.text || !block.text.elements) return '';

  return block.text.elements
    .map((el: any) => {
      if (el.text_run) return el.text_run.content || '';
      if (el.equation) return `$${el.equation.content}$`;
      if (el.mention) return `@${el.mention.name || ''}`;
      return '';
    })
    .join('');
}

function matchesPatterns(title: string, includePatterns?: string[], excludePatterns?: string[]): boolean {
  if (excludePatterns && excludePatterns.length > 0) {
    for (const pattern of excludePatterns) {
      if (title.includes(pattern)) return false;
    }
  }
  if (includePatterns && includePatterns.length > 0) {
    for (const pattern of includePatterns) {
      if (title.includes(pattern)) return true;
    }
    return false;
  }
  return true;
}

export async function fetchFeishuContent(config: FeishuConfig): Promise<FeishuFetchResult> {
  const { appId, appSecret, wikiSpaceId, docToken, includePatterns, excludePatterns, maxPages = MAX_PAGES, feishuDomain } = config;

  const apiBase = getApiBase(feishuDomain);
  const wikiBaseUrl = getWikiBaseUrl(feishuDomain);

  if (!appId || !appSecret) {
    throw new Error('飞书配置不完整，需要 appId 和 appSecret');
  }

  if (!wikiSpaceId && !docToken) {
    throw new Error('必须提供 wikiSpaceId 或 docToken');
  }

  logger.info('开始飞书内容获取', { module: 'FeishuConnector', wikiSpaceId: wikiSpaceId || '无', docToken: docToken || '无', maxPages, apiBase });

  const pages: FeishuPage[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  try {
    const token = await getTenantAccessToken(appId, appSecret, apiBase);

    if (wikiSpaceId) {
      const nodes = await fetchWikiNodes(token, wikiSpaceId, maxPages, apiBase);
      logger.info('从飞书 Wiki 获取节点列表', { module: 'FeishuConnector', count: nodes.length });

      for (const node of nodes) {
        if (pages.length >= maxPages) break;

        const title = node.title || '无标题';
        const objType = node.obj_type || 'doc';
        const objToken = node.obj_token || node.node_token;

        if (!matchesPatterns(title, includePatterns, excludePatterns)) continue;

        try {
          const content = await fetchNodeContent(token, objToken, objType, apiBase);

          if (content && content.trim().length > 20) {
            const wikiToken = node.node_token || node.obj_token;
            pages.push({
              id: wikiToken,
              title,
              markdown: content,
              url: `${wikiBaseUrl}/wiki/${wikiToken}`,
              updatedAt: node.last_edited_time || '',
              objType,
            });

            logger.info('飞书 Wiki 页面获取成功', {
              module: 'FeishuConnector',
              nodeToken: wikiToken,
              title: title.substring(0, 50),
              contentLength: content.length,
            });
          }
        } catch (error: any) {
          errors.push({ id: node.node_token || node.obj_token, error: error.message });
          logger.warn('飞书 Wiki 页面内容获取失败', { module: 'FeishuConnector', node: node.node_token, error: error.message });
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } else if (docToken) {
      const allDocNodes = await fetchDocChildNodes(token, docToken, maxPages, apiBase);
      logger.info('从飞书文档获取节点列表（含子节点）', { module: 'FeishuConnector', docToken, count: allDocNodes.length });

      for (const docNode of allDocNodes) {
        if (pages.length >= maxPages) break;

        const title = docNode.title;
        if (!matchesPatterns(title, includePatterns, excludePatterns)) continue;

        try {
          const content = await fetchNodeContent(token, docNode.objToken, docNode.objType, apiBase);

          if (content && content.trim().length > 20) {
            pages.push({
              id: docNode.nodeToken,
              title,
              markdown: content,
              url: `${wikiBaseUrl}/wiki/${docNode.nodeToken}`,
              updatedAt: '',
              objType: docNode.objType,
            });

            logger.info('飞书文档获取成功', {
              module: 'FeishuConnector',
              docToken: docNode.nodeToken,
              title: title.substring(0, 50),
              contentLength: content.length,
            });
          }
        } catch (error: any) {
          errors.push({ id: docNode.nodeToken, error: error.message });
          logger.warn('飞书文档内容获取失败', { module: 'FeishuConnector', docToken: docNode.nodeToken, error: error.message });
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  } catch (error: any) {
    logger.error('飞书内容获取失败', { module: 'FeishuConnector', error: error.message });
    throw error;
  }

  logger.info('飞书内容获取完成', { module: 'FeishuConnector', totalPages: pages.length, errorCount: errors.length });

  return { pages, totalPages: pages.length, errors };
}
