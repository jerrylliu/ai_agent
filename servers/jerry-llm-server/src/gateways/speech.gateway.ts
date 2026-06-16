/**
 * 语音识别 WebSocket 网关
 *
 * 处理前端 WebSocket 连接，中转 PCM 音频帧到火山引擎流式 ASR。
 *
 * 连接地址：ws://server/api/speech/stream?token={JWT}
 *
 * 前端 → 后端 消息格式：
 *   - 文本帧（JSON）：{ type: "stop" }
 *   - 二进制帧：PCM 16kHz/16bit/Mono 原始字节
 *
 * 后端 → 前端 消息格式（JSON 文本帧）：
 *   - { type: "interim", text: "...", index: 0 }
 *   - { type: "final", text: "...", index: 0, durationMs: 0 }
 *   - { type: "error", code: "...", message: "..." }
 *   - { type: "closed" }
 */

import { WebSocket } from 'ws';
import { SpeechService } from '../services/speech.service.js';
import { AuthService } from '../auth/auth.service.js';
import { logger } from '../fundamentals/logger.js';

/** 解析 WS 握手查询参数中的 token */
function extractParamsFromUrl(url: string | undefined): { token: string | null } {
  if (!url) return { token: null };
  try {
    const idx = url.indexOf('?');
    if (idx === -1) return { token: null };
    const params = new URLSearchParams(url.substring(idx));
    return { token: params.get('token') };
  } catch {
    return { token: null };
  }
}

/**
 * 处理语音识别 WebSocket 连接
 *
 * 在 main.ts 中被调用：wss.on('connection', handleSpeechWs)
 */
export function createSpeechWsHandler(
  speechService: SpeechService,
  authService: AuthService,
) {
  return async (ws: WebSocket, req: any) => {
    // 1. 鉴权
    const { token } = extractParamsFromUrl(req.url);
    if (!token) {
      ws.close(4001, '未提供认证令牌');
      return;
    }

    const decoded = authService.verifyToken(token);
    if (!decoded) {
      ws.close(4001, '认证令牌无效或已过期');
      return;
    }

    const userId = decoded.sub as string;
    logger.info(`语音识别 WS 连接: userId=${userId}`);

    // 标记前端 WS 是否已关闭，避免 onClose 中再次 ws.close()
    let clientWsClosed = false;

    /** 安全发送 JSON 到前端 */
    const sendToClient = (data: object) => {
      if (!clientWsClosed && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    };

    // 2. 连接火山引擎流式 ASR
    try {
      const client = await speechService.createStreamingClient(userId, {
        onInterim: (text, index) => {
          sendToClient({ type: 'interim', text, index });
        },
        onFinal: (text, index, durationMs) => {
          sendToClient({ type: 'final', text, index, durationMs });
        },
        onError: (error) => {
          sendToClient({ type: 'error', code: 'VOLC_ERROR', message: error });
        },
        onClose: () => {
          // 火山引擎 WS 关闭 → 通知前端 → 关闭前端 WS
          sendToClient({ type: 'closed' });
          if (!clientWsClosed) {
            clientWsClosed = true;
            ws.close();
          }
        },
      });

      // 3. 接收前端消息
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          // 二进制帧：PCM 音频数据
          speechService.sendAudio(userId, data);
        } else {
          // 文本帧：控制命令
          try {
            const msg = JSON.parse(data.toString('utf-8'));
            if (msg.type === 'stop') {
              speechService.finishStreaming(userId);
            }
          } catch {
            logger.warn('无效的 WS 控制帧');
          }
        }
      });

      ws.on('close', () => {
        clientWsClosed = true;
        logger.info(`语音识别 WS 断开: userId=${userId}`);
        speechService.closeStreamingClient(userId);
      });

      ws.on('error', (err) => {
        clientWsClosed = true;
        logger.error(`语音识别 WS 错误: userId=${userId}`, err);
        speechService.closeStreamingClient(userId);
      });
    } catch (e: any) {
      logger.error('创建流式 ASR 客户端失败', e);
      sendToClient({ type: 'error', code: 'CONNECT_FAIL', message: e.message });
      ws.close();
    }
  };
}
