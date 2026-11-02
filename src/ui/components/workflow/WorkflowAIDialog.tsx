import React, { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import DataAccessor from '../../lib/data/DataAccessor';
import ipc from '../../lib/ipc';
import { getNodeLabel } from './workflowConfig';
import { Channel, getChannelLabel } from '../../../configs/channelConfig';
import { useAppStore } from '@/store/appStore';
import { BotIcon, CheckIcon, SparklesIcon, UserIcon } from '@/components/common/icons';

interface WorkflowAIDialogProps {
  currentNodes: any[];
  currentEdges: any[];
  channel: Channel;
  onApplyOps: (ops: any) => void;
  onClose: () => void;
}

/** Models đã biết KHÔNG hỗ trợ tool calling (bỏ qua, báo lỗi rõ ràng — no fallback) */
const NO_TOOL_MODELS = [/\bgemma\b/i, /\bphi[-_]?3/i, /\bmimo\b/i];

function supportsTools(model: string): boolean {
  return !NO_TOOL_MODELS.some(re => re.test(model));
}

// ── Types cho agent result ──────────────────────────────────────────────────
interface AgentStep { type: string; message: string; ts: number }
interface AgentResult {
  success: boolean;
  ops?: {
    add?: { nodes: any[]; edges: any[] };
    update?: Array<{ nodeId: string; label?: string; config?: any }>;
    delete?: { nodeIds: string[] };
    rewire?: { edges: any[] };
    deleteEdges?: Array<{ source: string; target: string }>;
  };
  question?: string;
  summary?: string;
  steps?: AgentStep[];
  validation?: { warnings?: string[] };
  error?: string;
}

const STEP_ICON: Record<string, string> = {
  'tool-call': '🔧',
  'tool-result': '⚡',
  'thinking': '💭',
  'final': '🏁',
};

export default function WorkflowAIDialog({ currentNodes, currentEdges, channel, onApplyOps, onClose }: WorkflowAIDialogProps) {
  const { showNotification, theme } = useAppStore();
  const isLight = theme === 'light';
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [assistants, setAssistants] = useState<any[]>([]);
  const [selectedAssistantId, setSelectedAssistantId] = useState<string>('');
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState('');
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);
  const liveStepsRef = useRef<AgentStep[]>([]);
  const [history, setHistory] = useState<{ role: string; text: string }[]>([]);
  const [question, setQuestion] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stepsEndRef = useRef<HTMLDivElement>(null);

  const pushLiveStep = (s: AgentStep) => {
    liveStepsRef.current = [...liveStepsRef.current, s];
    setLiveSteps(liveStepsRef.current);
  };

  // Load assistants on mount
  useEffect(() => {
    (async () => {
      try {
        const defRes = await DataAccessor.getDefaultAssistant();
        if (defRes?.success && defRes.assistant) {
          setSelectedAssistantId(defRes.assistant.id);
        }
        const listRes = await DataAccessor.getAssistants();
        if (listRes?.success) {
          setAssistants(listRes.assistants || []);
          if (!defRes?.assistant && listRes.assistants.length > 0) {
            setSelectedAssistantId(listRes.assistants[0].id);
          }
        }
      } catch { /* ignore */ }
    })();
    textareaRef.current?.focus();
  }, []);

  // Auto-scroll step log
  useEffect(() => { stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [liveSteps]);

  // Live agent step stream (employee mode: Boss đẩy steps qua Socket.IO;
  // boss/standalone: bước cuối vẫn nhận qua REST response)
  useEffect(() => {
    const unsub = ipc.on('ai:agentStep', (data: any) => {
      if (data?.assistantId !== selectedAssistantId) return;
      const step = data?.step;
      if (step?.message) {
        pushLiveStep({ type: step.type || 'tool-call', message: step.message, ts: step.ts || Date.now() });
      }
    });
    return () => { unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAssistantId]);

  const selectedAssistant = assistants.find(a => a.id === selectedAssistantId);
  const modelSupportsTools = !selectedAssistant || supportsTools(selectedAssistant.model || '');

  const handleSubmit = async () => {
    if (!prompt.trim() || !selectedAssistantId) return;

    if (selectedAssistant && !modelSupportsTools) {
      setError(`Model "${selectedAssistant.model}" không hỗ trợ tool calling — agent không hoạt động. Chọn model khác (qwen2.5, llama3.1, DeepSeek, GPT, Claude...).`);
      return;
    }

    setLoading(true);
    setError('');
    setResult(null);
    setQuestion('');
    liveStepsRef.current = [];
    setLiveSteps([]);

    try {
      const res: AgentResult = await (ipc as any).ai.workflowAgent({
        assistantId: selectedAssistantId,
        currentNodes,
        currentEdges,
        channel,
        userPrompt: prompt,
        history: history.map(h => ({ role: h.role, content: h.text })),
      });

      // Replay steps từ response CHỈ KHI chưa nhận live stream
      // (boss/standalone: steps chỉ có trong response → replay tuần tự;
      //  employee: đã stream live qua Socket.IO → bỏ replay tránh trùng)
      const steps = res.steps || [];
      if (liveStepsRef.current.length === 0) {
        for (let i = 0; i < steps.length; i++) {
          setTimeout(() => pushLiveStep(steps[i]), i * 150);
        }
      }

      if (!res.success) {
        setError(res.error || 'Agent lỗi');
        setHistory(h => [...h, { role: 'user', text: prompt }]);
        return;
      }

      setResult(res);
      setHistory(h => [...h, { role: 'user', text: prompt }, { role: 'assistant', text: res.summary || res.question || '' }]);
      if (res.question) setQuestion(res.question);
      setPrompt('');
    } catch (err: any) {
      setError(err.message || 'Lỗi gọi agent');
    } finally {
      setLoading(false);
    }
  };

  const handleApply = () => {
    if (!result?.ops) return;
    onApplyOps(result.ops);
    showNotification('Đã áp dụng thay đổi lên canvas - nhớ Lưu!', 'success');
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // ── Diff summary từ ops ────────────────────────────────────────────────
  const diff = result?.ops ? (() => {
    const d: Array<{ kind: 'add' | 'update' | 'delete' | 'rewire' | 'cut'; text: string }> = [];
    (result.ops.add?.nodes || []).forEach(n =>
      d.push({ kind: 'add', text: `${n.label || getNodeLabel(n.type)} (${n.type})` }));
    (result.ops.update || []).forEach(u => {
      const node = currentNodes.find(n => n.id === u.nodeId);
      d.push({ kind: 'update', text: `${node?.label || u.nodeId}${u.label ? ` → "${u.label}"` : ''}` });
    });
    (result.ops.delete?.nodeIds || []).forEach(id => {
      const node = currentNodes.find(n => n.id === id);
      d.push({ kind: 'delete', text: node?.label || id });
    });
    (result.ops.rewire?.edges || []).forEach(e =>
      d.push({ kind: 'rewire', text: `${e.source} → ${e.target}` }));
    (result.ops.deleteEdges || []).forEach(e =>
      d.push({ kind: 'cut', text: `${e.source} —✂ ${e.target}` }));
    return d;
  })() : [];

  const diffColor: Record<string, string> = {
    add: isLight ? 'text-green-700' : 'text-green-400',
    update: isLight ? 'text-amber-700' : 'text-amber-400',
    delete: isLight ? 'text-red-700' : 'text-red-400',
    rewire: isLight ? 'text-blue-700' : 'text-blue-400',
    cut: isLight ? 'text-gray-600' : 'text-gray-400',
  };
  const diffIcon: Record<string, string> = { add: '+', update: '~', delete: '×', rewire: '→', cut: '✂' };

  const bgCard = isLight ? 'bg-white' : 'bg-gray-900';
  const borderCard = isLight ? 'border-gray-200' : 'border-gray-700';
  const bgInput = isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-800 border-gray-700';
  const textPrimary = isLight ? 'text-gray-900' : 'text-white';
  const textSecondary = isLight ? 'text-gray-400' : 'text-gray-400';
  const textMuted = isLight ? 'text-gray-400' : 'text-gray-400';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`${bgCard} border ${borderCard} rounded-2xl shadow-2xl w-[600px] max-h-[85vh] flex flex-col overflow-hidden`}>
        {/* Header */}
        <div className={`px-5 py-4 border-b ${borderCard} flex items-center justify-between flex-shrink-0`}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center text-white text-sm">
              <SparklesIcon className="w-4 h-4" />
            </div>
            <div>
              <p className={`${textPrimary} font-semibold text-sm`}>AI Workflow Agent</p>
              <p className={`${textMuted} text-[11px] mt-0.5`}>Tự lấy ngữ cảnh qua tools — tạo, sửa, xóa, nối node</p>
            </div>
          </div>
          <button onClick={onClose} className={`w-7 h-7 rounded-lg flex items-center justify-center ${textSecondary} hover:${textPrimary} hover:bg-gray-700/50 transition-colors`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Assistant picker */}
          {assistants.length > 0 && (
            <div>
              <label className={`${textSecondary} text-xs font-medium mb-1.5 block`}>Trợ lý AI (cần model hỗ trợ tool calling)</label>
              <select
                value={selectedAssistantId}
                onChange={e => setSelectedAssistantId(e.target.value)}
                className={`w-full ${bgInput} border rounded-xl px-3 py-2 text-sm ${textPrimary} outline-none focus:border-violet-500`}
              >
                {assistants.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.platform || 'openai'} - {a.model || 'default'})
                  </option>
                ))}
              </select>
              {selectedAssistant && !modelSupportsTools && (
                <p className="text-[11px] text-red-400 mt-1">⚠ Model "{selectedAssistant.model}" không hỗ trợ tool calling.</p>
              )}
            </div>
          )}

          {assistants.length === 0 && (
            <div className={`text-center py-6 ${textMuted}`}>
              <p className="text-sm mb-1">⚠ Chưa có trợ lý AI nào</p>
              <p className="text-xs">Vào <strong>Tích hợp → Trợ lý AI</strong> để tạo trợ lý trước</p>
            </div>
          )}

          {/* Conversation history */}
          {history.length > 0 && (
            <div className="space-y-2 max-h-[160px] overflow-y-auto">
              {history.map((h, i) => (
                <div key={i} className={`text-xs px-3 py-2 rounded-xl ${
                  h.role === 'user'
                    ? (isLight ? 'bg-blue-50 text-blue-700' : 'bg-blue-900/30 text-blue-300')
                    : (isLight ? 'bg-gray-100 text-gray-400' : 'bg-gray-800 text-gray-400')
                }`}>
                  <span className="font-semibold inline-flex items-center gap-1">{h.role === 'user' ? <><UserIcon className="w-3.5 h-3.5" /> Bạn: </> : <><BotIcon className="w-3.5 h-3.5" /> AI: </>}</span>
                  <span className="whitespace-pre-wrap">{h.text.substring(0, 300) + (h.text.length > 300 ? '…' : '')}</span>
                </div>
              ))}
            </div>
          )}

          {/* Live step log */}
          {(loading || liveSteps.length > 0) && (
            <div className={`border rounded-xl p-3 space-y-1 max-h-[180px] overflow-y-auto ${isLight ? 'border-violet-200 bg-violet-50/50' : 'border-violet-500/30 bg-violet-900/10'}`}>
              {loading && liveSteps.length === 0 && (
                <p className={`text-xs ${textMuted}`}>💭 Agent đang bắt đầu…</p>
              )}
              {liveSteps.map((s, i) => (
                <p key={i} className={`text-xs ${textMuted} flex items-center gap-1.5`}>
                  <span>{STEP_ICON[s.type] || '·'}</span>
                  <span>{s.message}</span>
                </p>
              ))}
              {loading && liveSteps.length > 0 && (
                <p className={`text-xs ${textMuted} flex items-center gap-1.5`}>
                  <span className="w-3 h-3 border-2 border-violet-400/30 border-t-violet-400 rounded-full animate-spin" />
                  đang chạy…
                </p>
              )}
              <div ref={stepsEndRef} />
            </div>
          )}

          {/* Question từ agent (Cách A) */}
          {question && !loading && (
            <div className={`border rounded-xl p-3 ${isLight ? 'border-amber-200 bg-amber-50' : 'border-amber-500/30 bg-amber-900/10'}`}>
              <p className={`text-xs font-semibold mb-1 ${isLight ? 'text-amber-700' : 'text-amber-400'}`}>
                <BotIcon className="w-4 h-4 inline" /> Agent cần làm rõ:
              </p>
              <p className={`text-xs whitespace-pre-wrap ${textPrimary}`}>{question}</p>
              <p className={`text-[11px] mt-1.5 ${textMuted}`}>Trả lời ở ô bên dưới để agent tiếp tục.</p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className={`text-xs px-3 py-2.5 rounded-xl ${isLight ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-red-900/20 text-red-400 border border-red-500/30'}`}>
              ⚠ {error}
            </div>
          )}

          {/* Diff preview */}
          {result?.ops && diff.length > 0 && (
            <div className={`border ${isLight ? 'border-green-200 bg-green-50' : 'border-green-500/30 bg-green-900/10'} rounded-xl p-3`}>
              <p className={`text-xs font-semibold mb-2 ${isLight ? 'text-green-700' : 'text-green-400'}`}>
                <CheckIcon className="w-4 h-4 inline" /> Agent đề xuất {diff.length} thay đổi:
              </p>
              <div className="space-y-1">
                {diff.map((d, i) => (
                  <div key={i} className={`flex items-center gap-2 text-xs ${diffColor[d.kind]}`}>
                    <span className="font-bold w-4 text-center">{diffIcon[d.kind]}</span>
                    <span>{d.text}</span>
                  </div>
                ))}
              </div>
              {(result.validation?.warnings || []).length > 0 && (
                <div className={`mt-2 pt-2 border-t ${isLight ? 'border-green-200' : 'border-green-500/20'}`}>
                  {(result.validation!.warnings || []).map((w, i) => (
                    <p key={i} className={`text-[11px] ${textMuted}`}>⚠ {w}</p>
                  ))}
                </div>
              )}
              {result.summary && (
                <p className={`text-[11px] mt-2 ${textMuted}`}>Agent: {result.summary.substring(0, 400)}</p>
              )}
            </div>
          )}

          {/* Prompt input */}
          {assistants.length > 0 && (
            <div>
              <label className={`${textSecondary} text-xs font-medium mb-1.5 block`}>
                {question ? 'Trả lời agent' : history.length > 0 ? 'Tiếp tục yêu cầu' : 'Mô tả việc cần làm (tạo mới hoặc sửa workflow)'}
              </label>
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                className={`w-full ${bgInput} border rounded-xl px-3 py-2.5 text-sm ${textPrimary} placeholder-gray-500 focus:border-violet-500 outline-none resize-none`}
                rows={4}
                placeholder={question
                  ? 'VD: Node Gửi giá...'
                  : currentNodes.length > 0
                    ? 'VD: Đổi nội dung tin nhắn trong node Gửi giá thành tiếng Anh, hoặc: xóa node phân loại, nối Trigger thẳng vào Trả lời'
                    : 'VD: Khi nhận tin nhắn chứa "giá", dùng AI phân loại rồi trả lời tự động'}
                disabled={loading}
              />
              <div className="flex items-center justify-between mt-1.5">
                <p className={`${textMuted} text-[11px]`}>Ctrl+Enter để gửi</p>
                <p className={`${textMuted} text-[11px]`}>
                  {currentNodes.length} node trên canvas · kênh {getChannelLabel(channel as Channel)}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`px-5 py-4 border-t ${borderCard} flex gap-2 flex-shrink-0`}>
          <button
            onClick={onClose}
            className={`flex-1 px-4 py-2.5 ${isLight ? 'bg-gray-100 hover:bg-gray-200 text-gray-700' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'} text-sm font-medium rounded-xl transition-colors`}
          >
            {result?.ops ? 'Hủy' : 'Đóng'}
          </button>
          {result?.ops ? (
            <button
              onClick={handleApply}
              className="flex-1 px-4 py-2.5 bg-green-600 hover:bg-green-500 text-white text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              Áp dụng {diff.length} thay đổi
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={loading || !prompt.trim() || !selectedAssistantId || (selectedAssistant ? !modelSupportsTools : false)}
              className="flex-1 px-4 py-2.5 bg-violet-600/30 hover:bg-violet-800 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Agent đang chạy…
                </>
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                  Gửi cho Agent
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
