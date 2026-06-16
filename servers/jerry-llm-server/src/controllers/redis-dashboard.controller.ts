/**
 * Redis 监控面板（RedisInsight 简易替代）
 *
 * 功能：
 *   1. GET /redis-dashboard        → 可视化监控页面
 *   2. GET /api/redis/status       → JSON 状态数据（供前端轮询）
 *
 * 设计原则：
 *   - 零外部依赖：纯 HTML + 内联 CSS/JS，不引入前端框架
 *   - 只读安全：所有接口均为 GET，不暴露写入/删除能力
 *   - 自动降级：Redis 不可用时返回降级信息，不抛错
 *   - 面试亮点：自己造轮子比用第三方工具更有说服力
 *
 * 安全注意：
 *   - Dashboard 接口使用 @SkipThrottle 跳过全局速率限制（5s 轮询会触发限流）
 *   - 仅限开发/内网环境使用，生产环境应加认证保护
 */

import { Controller, Get, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { getRedis, isRedisReady } from '../fundamentals/redis-client';
import { config } from '../fundamentals/config';
import { logger } from '../fundamentals/logger';

@Controller()
@SkipThrottle() // 跳过全局 ThrottlerGuard 限流，5s 轮询不会被 429
export class RedisDashboardController {
  /** 监控页面 HTML */
  @Get('redis-dashboard')
  async dashboard(@Res() res: Response) {
    // 将 keyPrefix 注入 HTML，避免 JS 模板字符串歧义
    const html = DASHBOARD_HTML.replace('__KEY_PREFIX__', config.redis.keyPrefix);
    res.type('text/html').send(html);
  }

  /** Redis 状态 JSON API */
  @Get('api/redis/status')
  async status() {
    const redis = getRedis();
    const connected = isRedisReady();

    // 基础信息
    const base = {
      connected,
      enabled: config.redis.enabled,
      host: config.redis.host,
      port: config.redis.port,
      db: config.redis.db,
      keyPrefix: config.redis.keyPrefix,
      rateLimitPerMin: config.rateLimit.chatPerMin,
    };

    if (!redis || !connected) {
      return { ...base, error: 'Redis 未连接', keys: {}, server: null, memory: null };
    }

    try {
      // 并发拉取所有数据，减少 RTT
      const [info, clientInfo, dbsize, allKeys, memInfo] = await Promise.all([
        redis.info('server').catch(() => null),
        redis.info('clients').catch(() => null),
        redis.dbsize().catch(() => 0),
        // 用 SCAN 代替 KEYS *，避免生产环境 key 多时阻塞 Redis 主线程
        this.scanAllKeys(redis),
        redis.info('memory').catch(() => null),
      ]);

      // 解析 server info
      const server = this.parseInfoSection(info, [
        'redis_version', 'uptime_in_seconds', 'uptime_in_days',
        'total_commands_processed',
      ]);
      // connected_clients 在 clients section
      const clients = this.parseInfoSection(clientInfo, ['connected_clients']);
      if (clients.connected_clients) {
        server.connected_clients = clients.connected_clients;
      }

      // 解析 memory info
      const memory = this.parseInfoSection(memInfo, [
        'used_memory_human', 'used_memory_peak_human',
        'maxmemory_human', 'mem_fragmentation_ratio',
      ]);

      // 按业务分类统计 key
      const keys = this.categorizeKeys(allKeys);

      // 用 pipeline 批量获取限流和锁详情，减少 RTT
      const [rateLimitDetails, lockDetails] = await Promise.all([
        this.getRateLimitDetails(redis, allKeys),
        this.getLockDetails(redis, allKeys),
      ]);

      return { ...base, keys, server, memory, rateLimitDetails, lockDetails, totalKeys: allKeys.length };
    } catch (e: any) {
      logger.warn('RedisDashboard: 获取状态失败', { err: e.message });
      return { ...base, error: e.message, keys: {}, server: null, memory: null };
    }
  }

  /**
   * 用 SCAN 代替 KEYS * 遍历所有 key。
   * KEYS * 会阻塞 Redis 主线程，key 多时导致服务不可用；
   * SCAN 是增量式遍历，不阻塞。
   */
  private async scanAllKeys(redis: NonNullable<ReturnType<typeof getRedis>>): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await redis.scan(cursor, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  /** 解析 Redis INFO 输出为 key-value 对象 */
  private parseInfoSection(info: string | null, fields: string[]): Record<string, string> {
    if (!info) return {};
    const result: Record<string, string> = {};
    for (const line of info.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...rest] = trimmed.split(':');
      if (fields.includes(key)) {
        result[key] = rest.join(':').trim();
      }
    }
    return result;
  }

  /** 按 jerry:xxx:yyy 前缀分类统计 key */
  private categorizeKeys(allKeys: string[]): Record<string, number> {
    const categories: Record<string, number> = {};
    for (const key of allKeys) {
      // 去掉 keyPrefix 后按第二段分类
      // jerry:rate-limit:chat:ip:xxx → rate-limit
      // jerry:lock:chat:session:xxx → lock
      // jerry:session-asset:xxx → session-asset
      const parts = key.split(':');
      const category = parts.length >= 2 ? parts[1] : 'other';
      categories[category] = (categories[category] || 0) + 1;
    }
    return categories;
  }

  /**
   * 获取限流 ZSET 详情（使用 pipeline 批量执行，减少 RTT）
   * pipeline 将多条命令打包成一次网络往返，比逐条执行快 5-10 倍
   */
  private async getRateLimitDetails(redis: NonNullable<ReturnType<typeof getRedis>>, allKeys: string[]) {
    const rlKeys = allKeys.filter(k => k.includes('rate-limit')).slice(0, 20);
    if (rlKeys.length === 0) return [];

    // pipeline 批量执行 ZCARD + TTL
    const pipe = redis.pipeline();
    for (const key of rlKeys) {
      pipe.zcard(key);
      pipe.ttl(key);
    }
    const results = await pipe.exec();

    const details: Array<{ key: string; count: number; ttl: number }> = [];
    if (results) {
      for (let i = 0; i < rlKeys.length; i++) {
        const countResult = results[i * 2];
        const ttlResult = results[i * 2 + 1];
        // exec 返回 [error, result] 元组
        if (countResult && !countResult[0] && ttlResult && !ttlResult[0]) {
          details.push({
            key: rlKeys[i],
            count: countResult[1] as number,
            ttl: ttlResult[1] as number,
          });
        }
      }
    }
    return details;
  }

  /**
   * 获取锁详情（使用 pipeline 批量执行）
   */
  private async getLockDetails(redis: NonNullable<ReturnType<typeof getRedis>>, allKeys: string[]) {
    const lockKeys = allKeys.filter(k => k.includes(':lock:')).slice(0, 20);
    if (lockKeys.length === 0) return [];

    // pipeline 批量执行 GET + TTL
    const pipe = redis.pipeline();
    for (const key of lockKeys) {
      pipe.get(key);
      pipe.ttl(key);
    }
    const results = await pipe.exec();

    const details: Array<{ key: string; token: string; ttl: number }> = [];
    if (results) {
      for (let i = 0; i < lockKeys.length; i++) {
        const getResult = results[i * 2];
        const ttlResult = results[i * 2 + 1];
        if (getResult && !getResult[0] && ttlResult && !ttlResult[0]) {
          const token = (getResult[1] as string) || '';
          details.push({
            key: lockKeys[i],
            token: token.substring(0, 12) + '...',
            ttl: ttlResult[1] as number,
          });
        }
      }
    }
    return details;
  }
}

/* ========================================================================== */
/*  内联 HTML 页面（零外部依赖，纯手写 CSS + 原生 JS）                          */
/*  注意：__KEY_PREFIX__ 占位符由服务端替换，不要用 ${} 模板语法               */
/* ========================================================================== */
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Redis Dashboard - Jerry LLM</title>
<style>
  :root {
    --bg: #0f1117;
    --card: #1a1d27;
    --border: #2a2d3a;
    --text: #e1e4ed;
    --text2: #8b8fa3;
    --green: #22c55e;
    --red: #ef4444;
    --yellow: #eab308;
    --blue: #3b82f6;
    --purple: #a855f7;
    --cyan: #06b6d4;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 24px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
  }
  .header h1 {
    font-size: 22px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .header h1 .icon { font-size: 26px; }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 500;
  }
  .badge-ok { background: rgba(34,197,94,.15); color: var(--green); }
  .badge-err { background: rgba(239,68,68,.15); color: var(--red); }
  .badge-warn { background: rgba(234,179,8,.15); color: var(--yellow); }
  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    display: inline-block;
  }
  .dot-ok { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .dot-err { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .refresh-info { font-size: 13px; color: var(--text2); }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
    margin-bottom: 20px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
  }
  .card-title {
    font-size: 13px;
    color: var(--text2);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 12px;
  }
  .card-value {
    font-size: 28px;
    font-weight: 700;
  }
  .card-sub {
    font-size: 13px;
    color: var(--text2);
    margin-top: 4px;
  }
  .section {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
  }
  .section-title {
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-title .emoji { font-size: 18px; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th {
    text-align: left;
    color: var(--text2);
    font-weight: 500;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 8px 12px;
    border-bottom: 1px solid rgba(42,45,58,.5);
  }
  tr:hover td { background: rgba(59,130,246,.05); }
  .mono { font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 12px; }
  .tag {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
  }
  .tag-green { background: rgba(34,197,94,.15); color: var(--green); }
  .tag-yellow { background: rgba(234,179,8,.15); color: var(--yellow); }
  .tag-red { background: rgba(239,68,68,.15); color: var(--red); }
  .tag-blue { background: rgba(59,130,246,.15); color: var(--blue); }
  .tag-purple { background: rgba(168,85,247,.15); color: var(--purple); }
  .tag-cyan { background: rgba(6,182,212,.15); color: var(--cyan); }
  .empty { color: var(--text2); font-style: italic; padding: 16px; text-align: center; }
  .bar-container { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px; }
  .bar-item {
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(59,130,246,.08);
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 13px;
  }
  .bar-item .count { font-weight: 700; color: var(--blue); }
  .bar-item .label { color: var(--text2); }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .loading { animation: pulse 1.5s infinite; color: var(--text2); }
</style>
</head>
<body>

<div class="header">
  <h1><span class="icon">&#9889;</span> Redis Dashboard</h1>
  <div style="display:flex;align-items:center;gap:12px;">
    <span id="statusBadge" class="badge badge-warn"><span class="dot dot-err"></span>加载中...</span>
    <span class="refresh-info">每 5s 自动刷新</span>
  </div>
</div>

<!-- 概览卡片 -->
<div class="grid" id="overviewCards">
  <div class="card">
    <div class="card-title">连接状态</div>
    <div class="card-value" id="connStatus" style="font-size:20px"><span class="loading">检测中...</span></div>
    <div class="card-sub" id="connSub"></div>
  </div>
  <div class="card">
    <div class="card-title">Key 总数</div>
    <div class="card-value" id="totalKeys">-</div>
    <div class="card-sub" id="keyCategories"></div>
  </div>
  <div class="card">
    <div class="card-title">内存使用</div>
    <div class="card-value" id="memUsed">-</div>
    <div class="card-sub" id="memPeak"></div>
  </div>
  <div class="card">
    <div class="card-title">运行时间</div>
    <div class="card-value" id="uptime">-</div>
    <div class="card-sub" id="version"></div>
  </div>
</div>

<!-- Key 分类统计 -->
<div class="section">
  <div class="section-title"><span class="emoji">&#128202;</span> Key 分类统计</div>
  <div class="bar-container" id="categoryBars"><span class="loading">加载中...</span></div>
</div>

<!-- 限流详情 -->
<div class="section">
  <div class="section-title"><span class="emoji">&#9201;</span> 限流 (Rate Limit) 详情</div>
  <div id="rateLimitTable"><span class="loading">加载中...</span></div>
</div>

<!-- 分布式锁详情 -->
<div class="section">
  <div class="section-title"><span class="emoji">&#128274;</span> 分布式锁 (Distributed Lock) 详情</div>
  <div id="lockTable"><span class="loading">加载中...</span></div>
</div>

<!-- 服务器信息 -->
<div class="section">
  <div class="section-title"><span class="emoji">&#128187;</span> Redis 服务器信息</div>
  <table id="serverTable"><tr><td class="loading">加载中...</td></tr></table>
</div>

<script>
const API = '/api/redis/status';
// 服务端注入的 keyPrefix 占位符（由 Controller 替换 __KEY_PREFIX__）
const KEY_PREFIX = '__KEY_PREFIX__';
let refreshTimer = null;

async function fetchStatus() {
  try {
    const res = await fetch(API);
    const data = await res.json();
    render(data);
  } catch (e) {
    document.getElementById('connStatus').innerHTML = '<span style="color:var(--red)">请求失败</span>';
  }
}

function render(d) {
  // 连接状态
  const badge = document.getElementById('statusBadge');
  const conn = document.getElementById('connStatus');
  const connSub = document.getElementById('connSub');
  if (d.connected) {
    badge.className = 'badge badge-ok';
    badge.innerHTML = '<span class="dot dot-ok"></span>已连接';
    conn.innerHTML = '<span style="color:var(--green)">Connected</span>';
    connSub.textContent = d.host + ':' + d.port + ' / DB ' + d.db;
  } else {
    badge.className = 'badge badge-err';
    badge.innerHTML = '<span class="dot dot-err"></span>未连接';
    conn.innerHTML = '<span style="color:var(--red)">Disconnected</span>';
    connSub.textContent = d.error || 'Redis 不可用';
  }

  // Key 总数
  document.getElementById('totalKeys').textContent = d.totalKeys ?? '-';

  // Key 分类
  const catEl = document.getElementById('categoryBars');
  if (d.keys && Object.keys(d.keys).length > 0) {
    catEl.innerHTML = Object.entries(d.keys).map(function(entry) {
      var k = entry[0], v = entry[1];
      var color = k === 'rate-limit' ? 'tag-yellow' : k === 'lock' ? 'tag-red' : k === 'session-asset' ? 'tag-blue' : 'tag-purple';
      return '<div class="bar-item"><span class="tag ' + color + '">' + k + '</span><span class="count">' + v + '</span></div>';
    }).join('');
    document.getElementById('keyCategories').textContent = Object.entries(d.keys).map(function(entry) {
      return entry[0] + ':' + entry[1];
    }).join(', ');
  } else {
    catEl.innerHTML = '<span style="color:var(--text2)">暂无 Key</span>';
    document.getElementById('keyCategories').textContent = '';
  }

  // 内存
  if (d.memory) {
    document.getElementById('memUsed').textContent = d.memory.used_memory_human || '-';
    document.getElementById('memPeak').textContent = '峰值: ' + (d.memory.used_memory_peak_human || '-');
  }

  // 运行时间（精确到分钟）
  if (d.server) {
    var totalSecs = parseInt(d.server.uptime_in_seconds) || 0;
    var days = Math.floor(totalSecs / 86400);
    var hours = Math.floor((totalSecs % 86400) / 3600);
    var mins = Math.floor((totalSecs % 3600) / 60);
    var uptimeText;
    if (days > 0) {
      uptimeText = days + '天 ' + hours + '小时';
    } else if (hours > 0) {
      uptimeText = hours + '小时 ' + mins + '分钟';
    } else {
      uptimeText = mins + '分钟';
    }
    document.getElementById('uptime').textContent = uptimeText;
    document.getElementById('version').textContent = 'Redis ' + (d.server.redis_version || '?');
  }

  // 限流表
  var rlEl = document.getElementById('rateLimitTable');
  if (d.rateLimitDetails && d.rateLimitDetails.length > 0) {
    rlEl.innerHTML = '<table><tr><th>Key</th><th>请求数</th><th>TTL</th><th>状态</th></tr>' +
      d.rateLimitDetails.map(function(r) {
        var limit = d.rateLimitPerMin || 30;
        var statusTag = r.count >= limit
          ? '<span class="tag tag-red">已限流</span>'
          : '<span class="tag tag-green">正常</span>';
        return '<tr><td class="mono">' + shortenKey(r.key) + '</td><td><b>' + r.count + '</b>/' + limit + '</td><td>' + r.ttl + 's</td><td>' + statusTag + '</td></tr>';
      }).join('') + '</table>';
  } else {
    rlEl.innerHTML = '<div class="empty">暂无限流记录（发送请求后出现）</div>';
  }

  // 锁表
  var lockEl = document.getElementById('lockTable');
  if (d.lockDetails && d.lockDetails.length > 0) {
    lockEl.innerHTML = '<table><tr><th>Key</th><th>Token</th><th>TTL</th><th>状态</th></tr>' +
      d.lockDetails.map(function(l) {
        var statusTag = l.ttl > 0
          ? '<span class="tag tag-yellow">锁定中</span>'
          : '<span class="tag tag-green">已释放</span>';
        return '<tr><td class="mono">' + shortenKey(l.key) + '</td><td class="mono">' + l.token + '</td><td>' + l.ttl + 's</td><td>' + statusTag + '</td></tr>';
      }).join('') + '</table>';
  } else {
    lockEl.innerHTML = '<div class="empty">暂无活跃锁（同 session 并发请求时出现）</div>';
  }

  // 服务器信息表
  if (d.server) {
    var rows = [
      ['版本', d.server.redis_version || '-'],
      ['运行时间', (function() {
        var s = parseInt(d.server.uptime_in_seconds) || 0;
        var d2 = Math.floor(s / 86400);
        var h2 = Math.floor((s % 86400) / 3600);
        var m2 = Math.floor((s % 3600) / 60);
        return d2 > 0 ? d2 + '天 ' + h2 + '小时' : h2 + '小时 ' + m2 + '分钟';
      })()],
      ['连接客户端', d.server.connected_clients || '-'],
      ['累计命令数', d.server.total_commands_processed || '-'],
    ];
    document.getElementById('serverTable').innerHTML =
      '<tr><th>属性</th><th>值</th></tr>' +
      rows.map(function(r) { return '<tr><td>' + r[0] + '</td><td class="mono">' + r[1] + '</td></tr>'; }).join('');
  }
}

function shortenKey(key) {
  // 服务端注入的 KEY_PREFIX 替代了原来的 ${config.redis.keyPrefix}
  // 避免 JS 模板字符串把服务端变量当 JS 变量解析
  return key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : key;
}

// 启动轮询
fetchStatus();
refreshTimer = setInterval(fetchStatus, 5000);
</script>
</body>
</html>`;
