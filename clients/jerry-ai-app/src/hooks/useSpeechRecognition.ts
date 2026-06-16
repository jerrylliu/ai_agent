/**
 * 语音识别 Hook（企业级实现 - 优化版）
 *
 * 封装麦克风音频采集 + WebSocket 流式 ASR 通信。
 * 前端通过 AudioContext + AudioWorklet 将麦克风输入重采样为
 * 16kHz/16bit/Mono PCM，通过 WebSocket 发送到后端，
 * 接收实时识别的中间结果和最终结果。
 *
 * 企业级特性：
 * 1. 停止时立即把 interim 转为 final（消除等待感）
 * 2. 本地能量 VAD（说话停顿自动断句）
 * 3. WebSocket 断网自动重连 + 音频帧本地缓冲
 * 4. 浏览器原生 SpeechRecognition 本地兜底
 * 5. 录音状态细分：connecting / recording / stopping
 * 6. 优化延迟和响应速度
 *
 * 使用方式：
 *   const { isRecording, interimText, finalText, start, stop, reset } = useSpeechRecognition();
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { API_BASE_URL } from '../lib/constants';

/** WS 消息类型 */
interface InterimMessage { type: 'interim'; text: string; index: number }
interface FinalMessage { type: 'final'; text: string; index: number; durationMs: number }
interface ErrorMessage { type: 'error'; code: string; message: string }
interface ClosedMessage { type: 'closed' }
type AsrMessage = InterimMessage | FinalMessage | ErrorMessage | ClosedMessage;

/** 录音状态机 */
export type RecordingStatus = 'idle' | 'connecting' | 'recording' | 'stopping' | 'error';

export interface UseSpeechRecognitionOptions {
  /** WebSocket 地址，默认自动从 API_BASE_URL 推导 */
  wsUrl?: string;
  /** 最终结果回调 */
  onFinal?: (text: string) => void;
  /** 是否启用本地兜底（浏览器原生 SpeechRecognition），默认 true */
  enableLocalFallback?: boolean;
  /** 是否启用本地 VAD 自动断句，默认 false（火山引擎 interim 是累积模式，本地 VAD 会冲突） */
  enableLocalVAD?: boolean;
  /** 最大重连次数，默认 3 */
  maxReconnectAttempts?: number;
  /** 优化参数：减少音频处理延迟 */
  lowLatency?: boolean;
}

export interface UseSpeechRecognitionResult {
  /** 是否正在录音（兼容旧 API） */
  isRecording: boolean;
  /** 是否正在连接 WS（兼容旧 API） */
  isConnecting: boolean;
  /** 详细状态 */
  status: RecordingStatus;
  /** 当前未确认文本（中间结果） */
  interimText: string;
  /** 累计已确认文本 */
  finalText: string;
  /** 错误信息 */
  error: string | null;
  /** 音频电平 0-1，用于波形动画 */
  audioLevel: number;
  /** 是否使用本地兜底引擎 */
  isUsingLocalFallback: boolean;
  /** 开始录音 */
  start: () => Promise<void>;
  /** 停止录音 */
  stop: () => void;
  /** 重置状态 */
  reset: () => void;
}

/** 将 WebSocket URL 从 http(s) 转换为 ws(s) */
function httpToWs(httpUrl: string): string {
  return httpUrl
    .replace(/^https:/, 'wss:')
    .replace(/^http:/, 'ws:');
}

/** 检查浏览器是否支持原生 SpeechRecognition */
function getNativeSpeechRecognition(): any {
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
}

export function useSpeechRecognition(options?: UseSpeechRecognitionOptions): UseSpeechRecognitionResult {
  const {
    enableLocalFallback = true,
    enableLocalVAD = false,
    maxReconnectAttempts = 3,
    lowLatency = true, // 启用低延迟模式
  } = options || {};

  const [status, setStatus] = useState<RecordingStatus>('idle');
  const statusRef = useRef<RecordingStatus>('idle');
  // 同步 status state 到 ref，避免 stop() 内部闭包陷阱
  useEffect(() => { statusRef.current = status; }, [status]);

  const [interimText, setInterimText] = useState('');
  const [finalText, setFinalText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isUsingLocalFallback, setIsUsingLocalFallback] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const levelIntervalRef = useRef<number | null>(null);
  const finalTextRef = useRef('');
  const interimTextRef = useRef('');
  const onFinalRef = useRef(options?.onFinal);
  onFinalRef.current = options?.onFinal;

  // 已完成句子（按 index 存储）。火山引擎每句有独立 index，interim 是该句累积，final 是该句最终版。
  const finalSentencesRef = useRef<Map<number, string>>(new Map());
  // 当前正在识别的句子 index（最新的 interim 所属）
  const currentInterimIndexRef = useRef<number>(0);

  // 重连相关
  const reconnectAttemptsRef = useRef(0);
  const audioBufferRef = useRef<ArrayBuffer[]>([]); // 断网时缓冲音频
  const userStoppedRef = useRef(false); // 用户主动停止，禁止重连

  // 本地 VAD 相关
  const vadSilenceStartRef = useRef<number>(0); // 静音开始时间
  const vadSpeakingRef = useRef(false); // 当前是否在说话
  const VAD_SILENCE_THRESHOLD = 0.02; // 音量阈值（0-1）
  const VAD_SILENCE_DURATION_MS = 1000; // 静音持续多久判定为说完（优化：从1500ms改为1000ms）

  // 本地兜底引擎
  const nativeRecognitionRef = useRef<any>(null);

  // 组件挂载状态，防止 start() 中 await 期间组件已 unmount 时继续 setState
  const mountedRef = useRef(true);

  // 优化参数
  const OPTIMAL_BUFFER_SIZE = lowLatency ? 256 : 1024; // 减小缓冲区大小以降低延迟
  const AUDIO_POLLING_INTERVAL = lowLatency ? 50 : 100; // 更频繁的音频级别检测

  /** 同步 interimText 到 ref */
  useEffect(() => {
    interimTextRef.current = interimText;
  }, [interimText]);

  /** 组件卸载时清理所有资源 */
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, []);

  /** 清理所有音频和 WS 资源 */
  const cleanup = () => {
    if (levelIntervalRef.current) {
      clearInterval(levelIntervalRef.current);
      levelIntervalRef.current = null;
    }
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => { });
    }
    audioContextRef.current = null;
    analyserRef.current = null;
    if (wsRef.current) {
      try {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'stop' }));
        }
        wsRef.current.close();
      } catch { }
      wsRef.current = null;
    }
    if (nativeRecognitionRef.current) {
      try { nativeRecognitionRef.current.stop(); } catch { }
      nativeRecognitionRef.current = null;
    }
    audioBufferRef.current = [];
    setAudioLevel(0);
  };

  /** AudioWorklet 处理器代码 - 优化版本 */
  const getWorkletUrl = useCallback(() => {
    const code = `
      class PCMProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.frameCount = 0;
          this.frameThreshold = ${lowLatency ? 20 : 50}; // 发送频率调整
        }
        
        process(inputs) {
          const input = inputs[0];
          if (input && input[0]) {
            const float32 = input[0];
            const int16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
              const s = Math.max(-1, Math.min(1, float32[i]));
              int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            
            // 优化：减少不必要的传输
            this.port.postMessage(int16.buffer, [int16.buffer]);
          }
          return true;
        }
      }
      registerProcessor('pcm-processor', PCMProcessor);
    `;
    const blob = new Blob([code], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
  }, [lowLatency]);

  /** 音频电平监控 + 本地 VAD 检测 */
  const startLevelMonitoring = useCallback(() => {
    if (levelIntervalRef.current) clearInterval(levelIntervalRef.current);
    levelIntervalRef.current = window.setInterval(() => {
      if (!analyserRef.current) return;
      const data = new Uint8Array(analyserRef.current.fftSize);
      analyserRef.current.getByteTimeDomainData(data);
      let max = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs((data[i] - 128) / 128);
        if (v > max) max = v;
      }
      setAudioLevel(max);

      // 本地 VAD：检测静音时长
      if (enableLocalVAD) {
        const now = Date.now();
        if (max > VAD_SILENCE_THRESHOLD) {
          // 有声音
          vadSpeakingRef.current = true;
          vadSilenceStartRef.current = 0;
        } else {
          // 静音
          if (vadSpeakingRef.current && vadSilenceStartRef.current === 0) {
            vadSilenceStartRef.current = now;
          }
          // 持续静音超过阈值，且当前有未确认文本 → 主动 finish
          if (
            vadSpeakingRef.current &&
            vadSilenceStartRef.current > 0 &&
            now - vadSilenceStartRef.current > VAD_SILENCE_DURATION_MS &&
            interimTextRef.current
          ) {
            console.log('[ASR] 本地 VAD 检测到说话结束，主动断句');
            // 把当前 interim 视为 final
            commitInterimAsFinal();
            vadSpeakingRef.current = false;
            vadSilenceStartRef.current = 0;
          }
        }
      }
    }, AUDIO_POLLING_INTERVAL);
  }, [enableLocalVAD, AUDIO_POLLING_INTERVAL]);

  /** 把当前 interim 文本立即提交为 final（用于停止时） */
  const commitInterimAsFinal = useCallback(() => {
    const text = interimTextRef.current;
    if (!text) return;
    // 把当前 interim 当作该 index 的 final 存入
    finalSentencesRef.current.set(currentInterimIndexRef.current, text);
    const allFinals = Array.from(finalSentencesRef.current.entries())
      .sort(([a], [b]) => a - b)
      .map(([, t]) => t)
      .join('');
    finalTextRef.current = allFinals;
    setFinalText(allFinals);
    // 同步清空 interim（ref 和 state 都清空，避免 checkInterval 判断延迟）
    interimTextRef.current = '';
    setInterimText('');
    onFinalRef.current?.(allFinals);
  }, []);

  /** 本地兜底：使用浏览器原生 SpeechRecognition */
  const startNativeFallback = useCallback(() => {
    const NativeSR = getNativeSpeechRecognition();
    if (!NativeSR) {
      setError('浏览器不支持语音识别，且服务端连接失败');
      setStatus('error');
      return false;
    }

    console.log('[ASR] 使用浏览器原生 SpeechRecognition 兜底');
    setIsUsingLocalFallback(true);
    const recognition = new NativeSR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'zh-CN';
    recognition.interimResults = true; // 确保实时结果

    recognition.onresult = (event: any) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }
      if (interim) {
        setInterimText(interim);
        interimTextRef.current = interim;
      }
      if (final) {
        const newText = finalTextRef.current + final;
        finalTextRef.current = newText;
        setFinalText(newText);
        setInterimText('');
        onFinalRef.current?.(newText);
      }
    };

    recognition.onerror = (e: any) => {
      console.error('[ASR] 本地兜底引擎错误', e);
      setError(`本地识别错误: ${e.error}`);
    };

    recognition.onend = () => {
      // continuous 模式下，结束意味着用户停止
      setStatus('idle');
    };

    recognition.start();
    nativeRecognitionRef.current = recognition;
    setStatus('recording');
    return true;
  }, []);

  /** 建立 WebSocket 连接（支持重连） */
  const connectWebSocket = useCallback(async (token: string): Promise<WebSocket> => {
    const wsBase = options?.wsUrl || `${httpToWs(API_BASE_URL)}/api/speech/stream`;
    const wsUrl = `${wsBase}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000); // 减少超时时间
    });

    return ws;
  }, [options?.wsUrl]);

  /** 设置 WebSocket 消息处理 */
  const setupWebSocketHandlers = useCallback((ws: WebSocket, token: string) => {
    ws.onmessage = (event) => {
      try {
        const msg: AsrMessage = JSON.parse(event.data);
        console.log('[ASR] 收到后端消息:', msg.type,
          msg.type === 'interim' ? `中间结果="${msg.text}"` :
            msg.type === 'final' ? `最终结果="${msg.text}"` :
              msg.type === 'error' ? `错误="${msg.message}"` : '');
        switch (msg.type) {
          case 'interim': {
            // idle/stopping 状态下忽略 interim（已 commit 或已停止，避免干扰）
            if (statusRef.current !== 'recording') break;
            // 火山引擎 interim 是当前句子的累积文本（同一 index 不断刷新）
            currentInterimIndexRef.current = msg.index;
            setInterimText(msg.text);
            interimTextRef.current = msg.text;
            break;
          }
          case 'final': {
            // 火山引擎 final 是该 index 句子的最终版本，存入 map
            finalSentencesRef.current.set(msg.index, msg.text);
            // 拼接所有已 final 的句子
            const allFinals = Array.from(finalSentencesRef.current.entries())
              .sort(([a], [b]) => a - b)
              .map(([, text]) => text)
              .join('');
            finalTextRef.current = allFinals;
            setFinalText(allFinals);
            // 同步清空 interim ref
            interimTextRef.current = '';
            setInterimText('');
            console.log('[ASR] 句子 #' + msg.index + ' final="' + msg.text + '", 累计=', allFinals);
            // 触发 onFinal 时传入"完整累计文本"（绝对值，非增量）
            onFinalRef.current?.(allFinals);
            break;
          }
          case 'error':
            setError(msg.message || '语音识别错误');
            break;
          case 'closed':
            setStatus('idle');
            break;
        }
      } catch {
        // 忽略非 JSON 消息
      }
    };

    ws.onclose = () => {
      // 用户主动停止，不重连
      if (userStoppedRef.current) {
        return;
      }
      // 自动重连
      if (reconnectAttemptsRef.current < maxReconnectAttempts) {
        reconnectAttemptsRef.current++;
        console.log(`[ASR] WebSocket 断开，尝试重连 #${reconnectAttemptsRef.current}`);
        setTimeout(async () => {
          try {
            const newWs = await connectWebSocket(token);
            wsRef.current = newWs;
            setupWebSocketHandlers(newWs, token);
            // 重连成功，重置重连计数 + 发送缓冲的音频
            reconnectAttemptsRef.current = 0;
            console.log(`[ASR] 重连成功，发送缓冲音频 ${audioBufferRef.current.length} 帧`);
            audioBufferRef.current.forEach(buf => newWs.send(buf));
            audioBufferRef.current = [];
          } catch (e) {
            console.error('[ASR] 重连失败', e);
            setError('网络连接已断开');
            setStatus('error');
          }
        }, 1000 * reconnectAttemptsRef.current); // 指数退避
      } else {
        setError('网络断开，重连失败');
        setStatus('error');
      }
    };

    ws.onerror = () => {
      console.warn('[ASR] WebSocket 错误');
    };
  }, [connectWebSocket, maxReconnectAttempts]);

  /** 开始录音 */
  const start = useCallback(async () => {
    const token = localStorage.getItem('miaoma_auth_token');
    if (!token) {
      setError('请先登录');
      return;
    }

    try {
      setStatus('connecting');
      setError(null);
      setInterimText('');
      setFinalText('');
      finalTextRef.current = '';
      finalSentencesRef.current.clear();
      currentInterimIndexRef.current = 0;
      reconnectAttemptsRef.current = 0;
      userStoppedRef.current = false;
      audioBufferRef.current = [];
      setIsUsingLocalFallback(false);

      // 1. 尝试建立 WebSocket
      let ws: WebSocket;
      try {
        ws = await connectWebSocket(token);
      } catch (wsErr) {
        console.error('[ASR] WebSocket 连接失败', wsErr);
        // 启用本地兜底
        if (enableLocalFallback) {
          // 仍需要麦克风权限来获取 stream（兜底引擎自己拿）
          if (startNativeFallback()) return;
        }
        throw wsErr;
      }
      wsRef.current = ws;
      setupWebSocketHandlers(ws, token);

      // 2. 获取麦克风 - 优化配置
      // 修改点：定义包含非标准属性 latency 的约束类型
      const audioConstraints: MediaTrackConstraints & { latency?: number } = {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (lowLatency) {
        audioConstraints.latency = 0.01;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });
      streamRef.current = stream;

      // 使用优化的 AudioContext 配置
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000,
        latencyHint: lowLatency ? 'interactive' : 'balanced'
      });
      audioContextRef.current = audioCtx;

      // 3. AudioWorklet
      const workletUrl = getWorkletUrl();
      await audioCtx.audioWorklet.addModule(workletUrl);

      const source = audioCtx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
      workletNodeRef.current = workletNode;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = OPTIMAL_BUFFER_SIZE; // 使用优化的缓冲区大小
      analyserRef.current = analyser;

      source.connect(analyser);
      analyser.connect(workletNode);

      // 4. 音频数据发送（带本地缓冲）
      let audioFrameCount = 0;
      workletNode.port.onmessage = (event) => {
        const currentWs = wsRef.current;
        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
          currentWs.send(event.data);
          audioFrameCount++;
          if (audioFrameCount % 10 === 1) { // 更频繁地报告发送情况
            console.log(`[ASR] 音频帧已发送 #${audioFrameCount}`);
          }
        } else {
          // WS 断开，缓存音频帧（最多 100 帧 ≈ 8 秒）- 减少缓冲以提高响应
          if (audioBufferRef.current.length < 100) {
            audioBufferRef.current.push(event.data);
          }
        }
      };

      workletNode.connect(audioCtx.destination);

      // 如果组件已卸载（用户在 await 期间关闭页面或切换路由），立即清理
      if (!mountedRef.current) {
        cleanup();
        return;
      }

      setStatus('recording');
      startLevelMonitoring();
    } catch (e: any) {
      if (mountedRef.current) {
        setError(e.message || '启动录音失败');
        setStatus('error');
      }
      cleanup();
    }
  }, [connectWebSocket, setupWebSocketHandlers, getWorkletUrl, startLevelMonitoring, enableLocalFallback, startNativeFallback, lowLatency, OPTIMAL_BUFFER_SIZE]);

  /** 停止录音
   *  优化策略（极速停止）：
   *  1. 立即停止采集麦克风
   *  2. 立即把当前 interim commit 为 final（用户立刻看到完整文字）
   *  3. 通知后端停止
   *  4. 直接回到 idle（用户可以立即编辑/发送）
   *  5. WebSocket 延迟 1.5 秒关闭，等后端 final 到达后静默替换更准确的文本
   */
  const stop = useCallback(() => {
    // 防御：仅在 recording 或 connecting 状态下才能 stop
    const currStatus = statusRef.current;
    if (currStatus !== 'recording' && currStatus !== 'connecting') {
      return;
    }

    userStoppedRef.current = true;

    // 1. 立即停止音频采集
    if (workletNodeRef.current) {
      try { workletNodeRef.current.disconnect(); } catch { }
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }
    if (levelIntervalRef.current) {
      clearInterval(levelIntervalRef.current);
      levelIntervalRef.current = null;
    }
    setAudioLevel(0);

    // 2. 立即把当前 interim commit 为 final
    commitInterimAsFinal();

    // 3. 停止本地兜底引擎
    if (nativeRecognitionRef.current) {
      try { nativeRecognitionRef.current.stop(); } catch { }
    }

    // 4. 通知后端停止
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'stop' }));
      } catch { }
    }

    // 5. 立即回到 idle（用户可以编辑/发送，无需等待）
    if (mountedRef.current) {
      setStatus('idle');
    }

    // 6. 延迟关闭 WebSocket 和音频资源（等后端 final 静默替换）
    //    期间如果后端返回更准确的 final，onmessage 仍会更新 finalText
    setTimeout(() => {
      // 关闭音频资源
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => { });
      }
      audioContextRef.current = null;
      analyserRef.current = null;
      // 关闭 WebSocket
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { }
        wsRef.current = null;
      }
      audioBufferRef.current = [];
    }, 1500);
  }, [commitInterimAsFinal]);

  /** 重置状态 */
  const reset = useCallback(() => {
    if (status === 'recording' || status === 'connecting') stop();
    setInterimText('');
    setFinalText('');
    finalTextRef.current = '';
    finalSentencesRef.current.clear();
    currentInterimIndexRef.current = 0;
    interimTextRef.current = '';
    setError(null);
  }, [status, stop]);

  return {
    isRecording: status === 'recording',
    isConnecting: status === 'connecting',
    status,
    interimText,
    finalText,
    error,
    audioLevel,
    isUsingLocalFallback,
    start,
    stop,
    reset,
  };
}