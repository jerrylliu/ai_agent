/**
 * 语音识别服务
 *
 * 编排流式 ASR 和长音频转写的业务逻辑：
 * - 管理流式 ASR 客户端的生命周期
 * - 长音频转写的提交与轮询
 * - ASR 用量统计（Redis 计数）
 */

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { StreamingAsrClient, submitFileTranscribe, queryFileTranscribe, type FileTranscribeResult } from '../fundamentals/volc-asr-provider.js';
import { getRedis } from '../fundamentals/redis-client.js';
import { logger } from '../fundamentals/logger.js';

/** 活跃的流式 ASR 连接（userId → client） */
const activeClients = new Map<string, StreamingAsrClient>();

@Injectable()
export class SpeechService implements OnModuleDestroy {

  /** 创建流式 ASR 客户端并连接火山引擎 */
  async createStreamingClient(
    userId: string,
    callbacks: {
      onInterim: (text: string, index: number) => void;
      onFinal: (text: string, index: number, durationMs: number) => void;
      onError: (error: string) => void;
      onClose: () => void;
    },
  ): Promise<StreamingAsrClient> {
    // 同一用户同时只允许一个流式会话
    const existing = activeClients.get(userId);
    if (existing) {
      existing.close();
      activeClients.delete(userId);
    }

    const client = new StreamingAsrClient({
      uid: userId,
      onInterim: callbacks.onInterim,
      onFinal: (text, index, durationMs) => {
        this.incrementUsage(userId, durationMs);
        callbacks.onFinal(text, index, durationMs);
      },
      onError: callbacks.onError,
      onClose: () => {
        activeClients.delete(userId);
        callbacks.onClose();
      },
    });

    await client.connect();
    activeClients.set(userId, client);
    return client;
  }

  /** 获取用户的活跃流式客户端 */
  getStreamingClient(userId: string): StreamingAsrClient | undefined {
    return activeClients.get(userId);
  }

  /** 关闭用户的流式客户端 */
  closeStreamingClient(userId: string): void {
    const client = activeClients.get(userId);
    if (client) {
      client.close();
      activeClients.delete(userId);
    }
  }

  /** 向流式客户端发送 PCM 音频帧 */
  sendAudio(userId: string, pcmBuffer: Buffer, isLast = false): boolean {
    const client = activeClients.get(userId);
    if (!client) return false;
    client.sendAudio(pcmBuffer, isLast);
    return true;
  }

  /** 结束用户的流式识别 */
  finishStreaming(userId: string): void {
    const client = activeClients.get(userId);
    if (client) {
      client.finish();
    }
  }

  /** 提交长音频转写任务 */
  async submitTranscribe(audioUrl: string, format: string, userId: string): Promise<{ taskId: string }> {
    this.incrementUsage(userId, 0); // 记录一次调用
    return submitFileTranscribe(audioUrl, format, userId);
  }

  /** 查询长音频转写结果 */
  async queryTranscribe(taskId: string, userId: string): Promise<FileTranscribeResult> {
    return queryFileTranscribe(taskId, userId);
  }

  /** 获取用户当日 ASR 用量（秒） */
  async getUsageSeconds(userId: string): Promise<number> {
    const redis = getRedis();
    if (!redis) return 0;
    const key = `asr:usage:${userId}:${new Date().toISOString().slice(0, 10)}`;
    const val = await redis.get(key);
    return val ? parseFloat(val) : 0;
  }

  /** 累加 ASR 用量（毫秒转秒） */
  private async incrementUsage(userId: string, durationMs: number): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
      const key = `asr:usage:${userId}:${new Date().toISOString().slice(0, 10)}`;
      const seconds = durationMs / 1000;
      await redis.incrbyfloat(key, seconds);
      // 48 小时过期
      await redis.expire(key, 48 * 3600).catch(() => {});
    } catch (e) {
      logger.warn('ASR 用量统计失败', e);
    }
  }

  onModuleDestroy() {
    for (const [userId, client] of activeClients) {
      client.close();
    }
    activeClients.clear();
  }
}
