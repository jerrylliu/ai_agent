/**
 * 火山引擎 ASR 2.0 协议封装
 * 
 * 提供两种能力：
 * 1. 流式实时转写（WebSocket 大模型 Seed ASR 2.0）
 * 2. 长音频文件转写（HTTP）
 * 
 * WebSocket 二进制协议帧格式（大端序）：
 *   [4B header][4B sequence?][4B payloadSize][payload]
 * 
 * header 各字节：
 *   byte0: [version(4b) 0b0001 | headerSize(4b) 0b0001] = 0x11
 *   byte1: [msgType(4b) | flags(4b)]
 *     msgType: 0b0001=full_client  0b0010=audio_only  0b1001=full_server  0b1111=error
 *     flags:   0b0000=noSeq  0b0001=posSeq  0b0010=lastNoSeq  0b0011=negSeq
 *   byte2: [serialization(4b) | compression(4b)]
 *     ser:  0b0000=none  0b0001=JSON
 *     comp: 0b0000=none  0b0001=Gzip
 *   byte3: reserved 0x00
 */

import WebSocket from 'ws';
import zlib from 'zlib';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { config } from './config.js';
import { logger } from './logger.js';
import { parseToolResultJson } from './llm-json-parser.js';

// ==================== 火山 ASR HTTP 响应 schema ====================
//
// /submit 与 /query 端点字段子集不同，分别校验：
// - submit 关注 code/message/id
// - query 关注 code/message/result.text/result.data
// 用 looseObject 透传未来扩展字段

const VolcAsrSubmitResponseSchema = z.looseObject({
  code: z.number().optional(),
  message: z.string().optional(),
  id: z.string().optional(),
});

const VolcAsrQueryResponseSchema = z.looseObject({
  code: z.number().optional(),
  message: z.string().optional(),
  result: z
    .looseObject({
      text: z.string().optional(),
      data: z
        .array(
          z.looseObject({
            text: z.string().optional(),
            start_time: z.number().optional(),
            end_time: z.number().optional(),
            confidence: z.number().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

// ==================== 二进制协议常量 ====================

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE = 0b0001; // 1 * 4 = 4 字节

// message_type (4 bits)
const MSG_FULL_CLIENT = 0b0001;
const MSG_AUDIO_ONLY = 0b0010;
const MSG_FULL_SERVER = 0b1001;
const MSG_SERVER_ERROR = 0b1111;

// message_type_specific_flags (4 bits)
const FLAG_NO_SEQ = 0b0000;
const FLAG_POS_SEQ = 0b0001;
const FLAG_NEG_SEQ = 0b0011;

// serialization (4 bits)
const SER_NONE = 0b0000;
const SER_JSON = 0b0001;

// compression (4 bits)
const COMP_NONE = 0b0000;
const COMP_GZIP = 0b0001;

/** 构造 4 字节协议头 */
function buildHeader(msgType: number, flags: number, ser: number, comp: number): Buffer {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (msgType << 4) | flags,
    (ser << 4) | comp,
    0x00,
  ]);
}

/** 构造 sequence number (4 字节大端序) */
function buildSequence(seq: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(seq, 0);
  return buf;
}

/** 构造 payload size (4 字节大端序 unsigned) */
function buildPayloadSize(size: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(size, 0);
  return buf;
}

/** Gzip 压缩 */
function gzipSync(data: Buffer | string): Buffer {
  const input = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  return zlib.gzipSync(input);
}

/** Gzip 解压 */
function gunzipSync(data: Buffer): string {
  return zlib.gunzipSync(data).toString('utf-8');
}

/**
 * 解析服务端二进制响应帧
 * 
 * 服务端响应格式：
 *   正常响应：[4B header][4B sequence][4B payloadSize][payload]
 *   错误帧：  [4B header][4B backend_code][4B payloadSize][payload]
 * 
 *   header byte1: msgType=0b1001 (full server) 或 0b1111 (error)
 */
function parseServerResponse(data: Buffer): { json: string; isError: boolean } | null {
  if (data.length < 12) {
    logger.warn(`ASR 响应数据过短: ${data.length} bytes`);
    return null;
  }

  const byte0 = data[0];
  const byte1 = data[1];
  const byte2 = data[2];

  // 检查协议版本和 header 大小
  const version = (byte0 >> 4) & 0x0f;
  if (version !== 0b0001) {
    logger.warn(`ASR 响应协议版本不匹配: ${version}`);
    return null;
  }

  const msgType = (byte1 >> 4) & 0x0f;
  const flags = byte1 & 0x0f;
  const compression = byte2 & 0x0f;
  const isError = msgType === MSG_SERVER_ERROR;

  if (msgType !== MSG_FULL_SERVER && msgType !== MSG_SERVER_ERROR) {
    logger.warn(`ASR 响应消息类型异常: ${msgType}`);
    return null;
  }

  // 计算 payloadSize 位置
  // 正常响应: header(4) + sequence(4) + payloadSize(4) = offset 8
  // 错误帧:   header(4) + backend_code(4) + sequence? + payloadSize(4)
  let offset = 4; // 跳过 header

  if (isError) {
    // 错误帧多一个 backend_code
    offset += 4;
  }

  if ((flags & FLAG_POS_SEQ) !== 0) {
    // 有 sequence
    offset += 4;
  }

  if (data.length < offset + 4) {
    logger.warn(`ASR 响应帧数据不足: need ${offset + 4}, got ${data.length}`);
    return null;
  }

  const payloadSize = data.readUInt32BE(offset);
  offset += 4;

  if (payloadSize > data.length - offset) {
    logger.warn(`ASR 响应 payload 大小不匹配: expected=${payloadSize}, available=${data.length - offset}`);
    return null;
  }

  const payload = data.subarray(offset, offset + payloadSize);

  try {
    const jsonStr = compression === COMP_GZIP
      ? gunzipSync(payload)
      : payload.toString('utf-8');
    logger.debug(`ASR 响应解析: msgType=${msgType} flags=${flags} payloadSize=${payloadSize} isError=${isError}`);
    return { json: jsonStr, isError };
  } catch (e) {
    logger.error('ASR 响应解压失败', e);
    return null;
  }
}

// ==================== 流式实时转写客户端 ====================

export interface StreamingAsrOptions {
  uid: string;
  onInterim?: (text: string, index: number, timestamp?: number) => void;
  onFinal?: (text: string, index: number, durationMs: number) => void;
  onError?: (error: string) => void;
  onClose?: () => void;
  onResult?: (result: any) => void; // 新增结果回调
  reconnectAttempts?: number; // 重连次数
  reconnectDelay?: number; // 重连延迟
}

export class StreamingAsrClient {
  private ws: WebSocket | null = null;
  private options: StreamingAsrOptions;
  private closed = false;
  private finished = false;
  private seq = 0;
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectDelay: number;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: StreamingAsrOptions) {
    this.options = options;
    this.maxReconnectAttempts = options.reconnectAttempts ?? 3;
    this.reconnectDelay = options.reconnectDelay ?? 3000;
  }

  async connect(): Promise<void> {
    if (!config.volcAsr.accessToken) {
      throw new Error('火山引擎 ASR 未配置（VOLC_ASR_ACCESS_TOKEN）');
    }

    const wsUrl = config.volcAsr.wsUrl;
    const connectId = randomUUID();
    this.seq = 0;

    return new Promise((resolve, reject) => {
      // 鉴权：新版控制台使用 X-Api-Key
      // X-Api-Connect-Id 用于追踪连接
      // skipUTF8Validation: 防止 ws 库因二进制响应帧误判 UTF-8 错误
      this.ws = new WebSocket(wsUrl, {
        perMessageDeflate: false,
        skipUTF8Validation: true,
        headers: {
          'X-Api-Key': config.volcAsr.accessToken,
          'X-Api-Resource-Id': config.volcAsr.resourceId,
          'X-Api-Connect-Id': connectId,
        },
      });

      const connectTimeout = setTimeout(() => {
        reject(new Error('WebSocket 连接超时'));
        this.ws?.close();
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(connectTimeout);
        logger.info(`ASR WebSocket 连接成功 (connectId=${connectId})`);
        this.reconnectAttempts = 0; // 重置重连计数

        // 发送 full client request（首帧）
        // header: byte0=0x11 byte1=0x11(全请求+带序号) byte2=0x11(JSON+Gzip) byte3=0x00
        this.seq = 1;
        const requestPayload = JSON.stringify({
          user: { uid: String(this.options.uid) },
          audio: {
            format: 'pcm',
            rate: 16000,
            bits: 16,
            channel: 1,
            language: 'zh-CN',
          },
          request: {
            model_name: 'seed_asr_2.0',
            enable_itn: true,
            enable_punc: true,
            enable_ddc: false,
            show_utterances: true,
            // VAD 参数：优化响应速度，减少等待感
            vad_enable: true,
            vad_start_timeout: 10000,   // 开始说话超时：10秒（给用户足够准备时间）
            vad_end_timeout: 400,        // 结束说话超时：400ms（停顿0.4秒即断句，大幅减少等待感）
            vad_end_wait_time: 100,      // 断句后等待：100ms（减少后端处理延迟）
            enable_timestamp: true,
            result_level: 3,             // 返回最详细结果（0=最简, 3=最全），确保不丢失文本
          },
        });

        const compressed = gzipSync(requestPayload);
        const header = buildHeader(MSG_FULL_CLIENT, FLAG_POS_SEQ, SER_JSON, COMP_GZIP);
        const frame = Buffer.concat([
          header,
          buildSequence(this.seq),
          buildPayloadSize(compressed.length),
          compressed,
        ]);

        logger.debug(`ASR full client request: seq=${this.seq} payloadLen=${requestPayload.length} compressedLen=${compressed.length}`);
        this.ws!.send(frame);
        resolve();
      });

      this.ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        // 在连接关闭状态下不再处理消息
        if (this.closed) {
          logger.debug('WebSocket 已关闭，忽略收到的消息');
          return;
        }

        try {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          const parsed = parseServerResponse(buf);
          if (!parsed) return;

          const resp = JSON.parse(parsed.json);

          if (parsed.isError) {
            const errMsg = resp.message || 'ASR 服务错误';
            logger.error(`火山 ASR 错误: code=${resp.code || '?'} message=${errMsg}`);
            this.options.onError?.(errMsg);
            return;
          }

          // 调用新结果回调
          this.options.onResult?.(resp);

          // 修复：安全地处理响应数据结构
          // 检查是否有 result 字段
          let results: any[] = [];
          
          if (Array.isArray(resp.result)) {
            // 直接是数组的情况
            results = resp.result;
          } else if (resp.result && typeof resp.result === 'object') {
            // result 是对象，可能包含单个结果
            results = [resp.result];
          } else if (Array.isArray(resp.results)) {
            // 尝试使用 results（复数形式）
            results = resp.results;
          } else if (resp.results && typeof resp.results === 'object') {
            // results 是对象
            results = [resp.results];
          } else if (resp.data && Array.isArray(resp.data)) {
            // 使用 data 字段
            results = resp.data;
          } else if (resp.data && typeof resp.data === 'object') {
            // data 是对象
            results = [resp.data];
          } else if (resp.text) {
            // 直接有文本字段，创建虚拟结果
            results = [{ text: resp.text }];
          } else {
            logger.warn(`ASR 响应格式未知: ${JSON.stringify(resp)}`);
            return;
          }

          logger.debug(`解析到 ${results.length} 个结果项`);

          for (const r of results) {
            // 检查连接状态，如果已关闭则停止处理
            if (this.closed) {
              logger.debug('WebSocket 已关闭，停止处理结果');
              break;
            }

            // 安全检查 utterances
            if (r.utterances && Array.isArray(r.utterances) && r.utterances.length > 0) {
              // 修复点：火山引擎 utterance 对象不包含 index 字段，u.index || 0 会让
              // 所有分句都落到 index=0，导致前端按 index 去重时新句覆盖旧句。
              // utterances 数组本身是按时间顺序累计返回（包含历史所有已识别的分句），
              // 所以直接用数组下标 i 作为该句的稳定全局 index。
              for (let i = 0; i < r.utterances.length; i++) {
                const u = r.utterances[i];
                if (u && typeof u === 'object') {
                  const idx = typeof u.index === 'number' ? u.index : i;
                  if (u.definite) {
                    // 最终结果
                    const startTime = u.start_time || 0;
                    const endTime = u.end_time || 0;
                    this.options.onFinal?.(u.text || '', idx, endTime - startTime);
                  } else {
                    // 中间结果
                    const timestamp = Date.now();
                    this.options.onInterim?.(u.text || '', idx, timestamp);
                  }
                }
              }
            } else if (r.text) {
              // 无 utterances 时直接用 text
              const timestamp = Date.now();
              // 根据 definite 属性判断是最终还是中间结果
              if (r.definite) {
                this.options.onFinal?.(r.text, r.index || 0, r.duration_ms || 0);
              } else {
                this.options.onInterim?.(r.text, r.index || 0, timestamp);
              }
            }
          }
        } catch (e) {
          logger.error('解析 ASR 响应失败', e);
          logger.error('原始响应数据:', data);
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(connectTimeout);
        logger.error('火山 ASR WebSocket 错误', err);
        
        if (!this.closed && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          logger.info(`开始第 ${this.reconnectAttempts} 次重连...`);
          
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
          }
          
          this.reconnectTimer = setTimeout(() => {
            this.reconnect();
          }, this.reconnectDelay);
        } else {
          if (!this.closed) {
            reject(err);
          }
          this.options.onError?.(err.message);
        }
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(connectTimeout);
        logger.info(`ASR WebSocket 关闭: code=${code} reason=${reason.toString()}`);
        
        // 设置关闭标志，防止后续操作
        this.closed = true;
        
        if (!this.closed && this.reconnectAttempts < this.maxReconnectAttempts) {
          logger.info(`WebSocket 关闭，准备重连...`);
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
          }
          this.reconnectTimer = setTimeout(() => {
            this.reconnect();
          }, this.reconnectDelay);
        } else {
          this.options.onClose?.();
        }
      });
    });
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    
    try {
      logger.info('正在重新连接 ASR 服务...');
      await this.connect();
      logger.info('重连成功');
    } catch (err) {
      logger.error(`重连失败: ${err}`);
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
          this.reconnect();
        }, this.reconnectDelay);
      } else {
        this.options.onError?.('达到最大重连次数，连接失败');
      }
    }
  }

  /** 发送 PCM 音频帧（不压缩，PCM 随机波形压缩率极低但压缩/解压开销大） */
  sendAudio(pcmBuffer: Buffer, isLast = false): void {
    if (!this.ws || this.closed || this.finished) {
      return;
    }

    this.seq++;
    const seq = isLast ? -this.seq : this.seq;
    const flags = isLast ? FLAG_NEG_SEQ : FLAG_POS_SEQ;

    // 不压缩：PCM 音频数据压缩率 <5%，gzip 反而增加 CPU 延迟
    const header = buildHeader(MSG_AUDIO_ONLY, flags, SER_NONE, COMP_NONE);

    const frame = Buffer.concat([
      header,
      buildSequence(seq),
      buildPayloadSize(pcmBuffer.length),
      pcmBuffer,
    ]);

    this.ws.send(frame);

    if (isLast) {
      this.finished = true;
    }
  }

  /** 主动结束识别（发送空音频负包，不压缩） */
  finish(): void {
    if (!this.ws || this.closed || this.finished) {
      return;
    }

    this.seq++;
    const seq = -this.seq;
    const header = buildHeader(MSG_AUDIO_ONLY, FLAG_NEG_SEQ, SER_NONE, COMP_NONE);

    const emptyPayload = Buffer.alloc(0);
    const frame = Buffer.concat([
      header,
      buildSequence(seq),
      buildPayloadSize(0),
      emptyPayload,
    ]);

    this.finished = true;
    logger.info(`ASR finish frame: seq=${seq}`);
    this.ws.send(frame);
  }

  close(): void {
    logger.info('正在关闭 ASR 客户端');
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { 
        this.ws.close(); 
      } catch (err) {
        logger.error('关闭 WebSocket 时出错', err);
      }
      this.ws = null;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

// ==================== 长音频文件转写 ====================

export interface FileTranscribeResult {
  taskId: string;
  status: 'pending' | 'success' | 'failed';
  text?: string;
  segments?: Array<{ start: number; end: number; text: string; confidence?: number }>;
  message?: string;
}

export async function submitFileTranscribe(
  audioUrl: string,
  format: string = 'wav',
  uid: string = 'system',
  language: string = 'zh-CN', // 新增语言参数
  enablePunctuation: boolean = true, // 新增标点参数
  enableITN: boolean = true, // 新增ITN参数
): Promise<{ taskId: string }> {
  const reqid = randomUUID();
  const submitUrl = config.volcAsr.httpUrl + '/submit';

  const body = JSON.stringify({
    app: {
      appid: config.volcAsr.appId,
      token: config.volcAsr.accessToken,
      cluster: 'volcengine_input_common',
    },
    user: { uid: String(uid) },
    audio: { 
      format, 
      url: audioUrl,
      language, // 添加语言设置
    },
    request: {
      reqid,
      // 添加识别参数
      enable_punct: enablePunctuation,
      enable_itn: enableITN,
      response_params: {
        enable_word_info: true, // 返回词级别信息
        enable_sentence_info: true, // 返回句子级别信息
      }
    },
  });

  const resp = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': config.volcAsr.accessToken,
      'X-Api-Resource-Id': 'volc.seedasr.auc',
      'X-Api-Connect-Id': reqid,
    },
    body,
  });

  const respText = await resp.text();
  const parsed = parseToolResultJson(respText, VolcAsrSubmitResponseSchema, {
    module: 'VolcAsrProvider',
    api: 'submit',
    reqid,
  });
  if (!parsed.success) {
    throw new Error(`提交转写任务响应结构异常: ${parsed.reason}`);
  }
  const data = parsed.data;
  if (data.code !== 0) {
    throw new Error(`提交转写任务失败: ${data.message}`);
  }

  return { taskId: data.id || reqid };
}

export async function queryFileTranscribe(taskId: string, uid: string = 'system'): Promise<FileTranscribeResult> {
  const queryUrl = config.volcAsr.httpUrl + '/query';
  const reqid = randomUUID();

  const body = JSON.stringify({
    app: {
      appid: config.volcAsr.appId,
      token: config.volcAsr.accessToken,
      cluster: 'volcengine_input_common',
    },
    user: { uid: String(uid) },
    request: { reqid, id: taskId },
  });

  const resp = await fetch(queryUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': config.volcAsr.accessToken,
      'X-Api-Resource-Id': 'volc.seedasr.auc',
      'X-Api-Connect-Id': reqid,
    },
    body,
  });

  const respText = await resp.text();
  const parsed = parseToolResultJson(respText, VolcAsrQueryResponseSchema, {
    module: 'VolcAsrProvider',
    api: 'query',
    reqid,
    taskId,
  });
  if (!parsed.success) {
    return { taskId, status: 'failed', message: `查询转写响应结构异常: ${parsed.reason}` };
  }
  const data = parsed.data;

  if (data.code === 0) {
    const text = data.result?.text || data.result?.data?.[0]?.text || '';
    const segments = (data.result?.data || []).map((s) => ({
      start: s.start_time ?? 0,
      end: s.end_time ?? 0,
      text: s.text ?? '',
      confidence: s.confidence ?? 1.0, // 添加置信度
    }));
    return { taskId, status: 'success', text, segments };
  }

  if (data.code === 1) {
    return { taskId, status: 'pending' };
  }

  return { taskId, status: 'failed', message: data.message || '转写失败' };
}

// ==================== 工具函数 ====================

/**
 * 将WAV文件转换为PCM格式
 * @param wavBuffer WAV格式音频数据
 * @returns PCM格式音频数据
 */
export function convertWavToPcm(wavBuffer: Buffer): Buffer {
  // 检查WAV文件头
  if (wavBuffer.slice(0, 4).toString() !== 'RIFF') {
    throw new Error('无效的WAV文件');
  }
  
  // 查找data块
  let offset = 12; // 跳过RIFF头
  while (offset < wavBuffer.length - 8) {
    const chunkId = wavBuffer.slice(offset, offset + 4).toString();
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    
    if (chunkId === 'data') {
      // 返回音频数据部分
      return wavBuffer.slice(offset + 8, offset + 8 + chunkSize);
    }
    
    offset += 8 + chunkSize;
    // 确保chunkSize是偶数
    if (chunkSize % 2 !== 0) offset++;
  }
  
  throw new Error('WAV文件中未找到音频数据');
}

/**
 * 音频数据分片发送
 * @param client ASR客户端
 * @param pcmData PCM音频数据
 * @param chunkSize 分片大小，默认1600字节（100ms@16kHz 16bit mono）
 */
export function sendAudioInChunks(client: StreamingAsrClient, pcmData: Buffer, chunkSize: number = 1600): void {
  for (let i = 0; i < pcmData.length; i += chunkSize) {
    if (client.isClosed) {
      logger.debug('客户端已关闭，停止发送音频');
      break;
    }
    
    const chunk = pcmData.slice(i, Math.min(i + chunkSize, pcmData.length));
    const isLast = i + chunkSize >= pcmData.length;
    client.sendAudio(chunk, isLast);
    
    // 适当延时，模拟实时发送
    if (!isLast) {
      // 这里可以使用异步延时来控制发送节奏
      // await new Promise(resolve => setTimeout(resolve, 100)); // 100ms间隔
    }
  }
}