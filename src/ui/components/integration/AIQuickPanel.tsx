/**
 * AIQuickPanel.tsx
 * Side panel chat trực tiếp với AI - hiển thị bên phải khung chat.
 * Cho phép chọn trợ lý, chat hỏi đáp, insert câu trả lời vào MessageInput.
 * Tự động inject ngữ cảnh hội thoại Zalo hiện tại khi gửi câu hỏi.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useChatStore } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { parseStructuredResponse, type AIStructuredSegment } from '../../../utils/aiUtils';
import { BotIcon, ClipboardListIcon, DiamondIcon, EditIcon, FileTextIcon, HelpCircleIcon, LightningIcon, SparklesIcon, StarIcon, TargetIcon } from '@/components/common/icons';
import ForwardMessageModal from '../chat/ForwardMessageModal';
import type { AIChatRecipientRequest, ZaloMessageTarget } from '../../../models/aiChatTools';
import { sendSelectedZaloMessages, summarizeZaloSendResults } from '../../../utils/zaloMessageTools';
import AIGroupActionModal from './AIGroupActionModal';
import AIQuoteRecipientsModal from './AIQuoteRecipientsModal';
import AIQuoteReplyCard, { hasQuoteAmount } from './AIQuoteReplyCard';


interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  persistedId?: number;
  segments?: AIStructuredSegment[];
}

interface AssistantSummary {
  id: string;
  name: string;
  platform: string;
  model: string;
  isDefault: boolean;
  enabled: boolean;
  contextMessageCount?: number;
}

const PLATFORM_ICONS: Record<string, React.ReactNode> = {
  openai: <BotIcon className="w-4 h-4" />,
  gemini: <SparklesIcon className="w-4 h-4" />,
  deepseek: <HelpCircleIcon className="w-4 h-4" />,
  grok: <LightningIcon className="w-4 h-4" />,
};
// Text fallback for use in <option> elements (cannot render JSX)
const PLATFORM_ICON_TEXTS: Record<string, string> = {
  openai: '[AI]', gemini: '[G]', deepseek: '[DS]', grok: '[Grok]',
};

const clampContextCount = (value: number) => Math.min(100, Math.max(1, Math.round(value)));

async function getPanelConversationId(accountId: string | null, threadId: string | null, assistantId: string): Promise<string | null> {
  if (!accountId || !threadId || !assistantId) return null;
  try {
    const res = await ipc.ai?.getOrCreateConversation({ zaloId: accountId, threadId, assistantId });
    return res?.success ? res.conversation?.id || null : null;
  } catch { return null; }
}

async function createPanelConversationId(accountId: string | null, threadId: string | null, assistantId: string): Promise<string | null> {
  try {
    const res = await ipc.ai?.createConversation({ zaloId: accountId || '', threadId: threadId || '', assistantId });
    return res?.success ? res.conversation?.id || null : null;
  } catch { return null; }
}

/** Persistence is best effort and must never prevent a new chat turn. */
async function savePanelMessage(conversationReady: Promise<string | null>, message: {
  role: 'user' | 'assistant'; content: string; segmentsJson?: string;
}): Promise<string | null> {
  const conversationId = await conversationReady;
  if (conversationId) {
    try { await ipc.ai?.addConversationMessage({ conversationId, ...message }); } catch {}
  }
  return conversationId;
}

export default function AIQuickPanel({ onClose }: { onClose: () => void }) {
  const [assistants, setAssistants] = useState<AssistantSummary[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingAssistants, setLoadingAssistants] = useState(true);
  const [assistantContextMsgCount, setAssistantContextMsgCount] = useState(30);
  const [contextCountInput, setContextCountInput] = useState('30');
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [quoteRecipientsOpen, setQuoteRecipientsOpen] = useState(false);
  const conversationRef = useRef<{ scope: string; ready: Promise<string | null> } | null>(null);
  const historyRevisionRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [recipientRequest, setRecipientRequest] = useState<{
    request: AIChatRecipientRequest;
    conversationReady: Promise<string | null>;
    scope: string;
    accountId: string | null;
  } | null>(null);
  const [sendingZalo, setSendingZalo] = useState(false);
  const sendingZaloRef = useRef(false);
  const chatTurnRef = useRef(false);
  const mountedRef = useRef(true);
  const [quoteProcessing, setQuoteProcessing] = useState(false);
  const [quoteReplyError, setQuoteReplyError] = useState('');

  const { activeThreadId, activeThreadType } = useChatStore();
  const { activeAccountId } = useAccountStore();
  const scope = JSON.stringify([activeAccountId, activeThreadId, activeId]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => { setRecipientRequest(null); }, [scope]);
  const {
    aiAutoInjectZaloContext,
    setAiAutoInjectZaloContext,
    aiQuickPanelContextCountOverride,
    setAiQuickPanelContextCountOverride,
    aiThreadAssistantMap,
    setAiThreadAssistant,
  } = useAppStore();

  // Load assistants + restore cached assistant for current thread
  useEffect(() => {
    (async () => {
      setLoadingAssistants(true);
      try {
        const res = await ipc.ai?.listAssistants();
        if (res?.success) {
          const enabled = (res.assistants || []).filter((a: AssistantSummary) => a.enabled);
          setAssistants(enabled);
          // Restore cached assistant for current thread, fallback to default
          const threadKey = activeAccountId && activeThreadId ? `${activeAccountId}_${activeThreadId}` : '';
          const cachedId = threadKey ? aiThreadAssistantMap[threadKey] : '';
          const cached = cachedId ? enabled.find(a => a.id === cachedId) : null;
          const def = cached || enabled.find((a: AssistantSummary) => a.isDefault) || enabled[0];
          if (def) setActiveId(def.id);
        }
      } catch {}
      setLoadingAssistants(false);
    })();
  }, []);

  // Auto scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Load conversation when thread OR assistant changes
  useEffect(() => {
    let cancelled = false;
    const historyRevision = ++historyRevisionRef.current;
    setMessages([]);
    const ready = getPanelConversationId(activeAccountId, activeThreadId, activeId);
    conversationRef.current = { scope, ready };
    if (!activeId) return () => { cancelled = true; };

    // Cache assistant selection for this thread
    if (activeAccountId && activeThreadId) setAiThreadAssistant(`${activeAccountId}_${activeThreadId}`, activeId);

    // Fetch contextMessageCount for this assistant
    const currentAssistant = assistants.find(a => a.id === activeId);
    const initialDefault = clampContextCount(currentAssistant?.contextMessageCount || 30);
    setAssistantContextMsgCount(initialDefault);

    // Config and history load independently. Neither gates typing or sending.
    void (async () => {
      try {
        const res = await ipc.ai?.getAssistant(activeId);
        if (!cancelled && res?.success && res.assistant) {
          setAssistantContextMsgCount(clampContextCount(res.assistant.contextMessageCount || 30));
        }
      } catch {}
    })();

    void (async () => {
      try {
        const conversationId = await ready;
        if (cancelled || !conversationId) return;
        const msgRes = await ipc.ai?.getConversationMessages({ conversationId });
        // A late history response must not erase a message the user just sent.
        if (cancelled || historyRevisionRef.current !== historyRevision) return;
        if (msgRes?.success && msgRes.messages?.length > 0) {
          const loaded: ChatMsg[] = msgRes.messages.map((m: any) => ({
            role: m.role,
            content: m.content,
            persistedId: Number(m.id),
            segments: m.segments_json ? JSON.parse(m.segments_json) : undefined,
          }));
          setMessages(previous => [...loaded, ...previous.filter(message => message.persistedId && !loaded.some(saved => saved.persistedId === message.persistedId))]);
        }
      } catch { /* History is optional for starting a new turn. */ }
    })();
    return () => { cancelled = true; };
  }, [activeId, activeThreadId, activeAccountId, assistants]);

  const effectiveContextMsgCount = aiQuickPanelContextCountOverride ?? assistantContextMsgCount;
  const isUsingAssistantDefaultContext = aiQuickPanelContextCountOverride === null;

  useEffect(() => {
    setContextCountInput(String(effectiveContextMsgCount));
  }, [effectiveContextMsgCount]);

  /** Lấy ngữ cảnh hội thoại Zalo hiện tại (trả về null nếu không có) */
  const getRawZaloChatContext = useCallback((): string | null => {
    if (!activeAccountId || !activeThreadId) return null;
    const key = `${activeAccountId}_${activeThreadId}`;
    const msgs = useChatStore.getState().messages[key] || [];
    const recent = msgs.slice(-effectiveContextMsgCount);
    if (recent.length === 0) return null;
    const contextText = recent.map((m: any) => {
      const content = typeof m.content === 'string'
        ? m.content
        : (m.content?.msg || JSON.stringify(m.content));
      return `${m.is_sent ? 'Tôi' : 'Khách'}: ${content}`;
    }).join('\n');
    return contextText || null;
  }, [activeAccountId, activeThreadId, effectiveContextMsgCount]);

  const getZaloChatContext = useCallback((): string | null => {
    if (!aiAutoInjectZaloContext) return null;
    return getRawZaloChatContext();
  }, [aiAutoInjectZaloContext, getRawZaloChatContext]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeId || loading || chatTurnRef.current || recipientRequest || sendingZaloRef.current) return;
    chatTurnRef.current = true;
    historyRevisionRef.current += 1;
    const turnScope = scope;

    const userMsg: ChatMsg = { role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    const conversationReady = conversationRef.current?.scope === turnScope
      ? conversationRef.current.ready
      : getPanelConversationId(activeAccountId, activeThreadId, activeId);
    const userSaved = savePanelMessage(conversationReady, { role: 'user', content: text });

    try {
      const panelMsgs = [...messages, userMsg];

      // Auto-inject Zalo chat context nếu có thread đang active
      const msgsToSend: ChatMsg[] = [];
      const zaloContext = getZaloChatContext();
      if (zaloContext) {
        msgsToSend.push(
          { role: 'user', content: `[Ngữ cảnh hội thoại Zalo hiện tại - ${effectiveContextMsgCount} tin nhắn gần nhất]\n${zaloContext}` },
          { role: 'assistant', content: 'Đã nắm được ngữ cảnh hội thoại. Tôi sẽ trả lời dựa trên ngữ cảnh này.' },
        );
      }
      msgsToSend.push(...panelMsgs);

      const res = await ipc.ai?.chat(activeId, msgsToSend, true, undefined, true, {
        zaloId: activeAccountId || '',
        threadId: activeThreadId || '',
        threadType: activeThreadType,
        content: text,
      });
      if (res?.success && res.recipientRequest?.type === 'send_quote_to_configured_recipients') {
        // Do not render or persist a staging response. Show the actual send
        // outcome once the configured recipients have been processed.
        if (mountedRef.current && scopeRef.current === turnScope) {
          await sendQuoteToConfiguredRecipients(res.recipientRequest, userSaved, turnScope);
        }
      } else if (res?.success && res.result) {
        const segments = parseStructuredResponse(res.result);
        const assistantMsg: ChatMsg = { role: 'assistant', content: res.result!, segments: segments || undefined };
        const responseSaved = savePanelMessage(userSaved, {
          role: 'assistant', content: res.result!, segmentsJson: segments ? JSON.stringify(segments) : undefined,
        });
        if (mountedRef.current && scopeRef.current === turnScope) {
          setMessages(prev => [...prev, assistantMsg]);
           if (res.recipientRequest?.type === 'insert_zalo_chat_reply') {
             window.dispatchEvent(new CustomEvent('ai:insertToChat', { detail: { text: res.recipientRequest.message } }));
           } else if (res.recipientRequest) {
             setRecipientRequest({ request: res.recipientRequest, conversationReady: responseSaved, scope: turnScope, accountId: activeAccountId });
           }
        }
      } else {
        const errorMsg: ChatMsg = { role: 'assistant', content: `Error: ${res?.error || 'Không có phản hồi'}` };
        if (mountedRef.current && scopeRef.current === turnScope) setMessages(prev => [...prev, errorMsg]);
      }
    } catch (e: any) {
      if (mountedRef.current && scopeRef.current === turnScope) setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message}` }]);
    }
    chatTurnRef.current = false;
    if (mountedRef.current) setLoading(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [input, activeId, loading, messages, getZaloChatContext, effectiveContextMsgCount, activeAccountId, activeThreadId, activeThreadType, scope, recipientRequest]);

  // Tool outcomes are facts from IPC, not claims generated by the model.
  const recordZaloToolResult = useCallback((text: string, context: NonNullable<typeof recipientRequest>) => {
    const segments = [{ type: 'text' as const, content: text }];
    const content = JSON.stringify(segments);
    if (mountedRef.current && scopeRef.current === context.scope) {
      setMessages(prev => [...prev, { role: 'assistant', content, segments }]);
    }
    void savePanelMessage(context.conversationReady, { role: 'assistant', content, segmentsJson: content });
  }, []);

  const cancelRecipientSelection = useCallback(() => {
    if (!recipientRequest || sendingZaloRef.current) return;
    const cancelMessages: Record<string, string> = {
      select_zalo_recipients: 'Đã hủy chọn người nhận. Không gửi tin nhắn.',
      create_zalo_group: 'Đã hủy thao tác tạo nhóm.',
      add_zalo_group_members: 'Đã hủy thao tác thêm thành viên.',
      remove_zalo_group_members: 'Đã hủy thao tác xóa thành viên.',
      send_zalo_friend_requests: 'Đã hủy thao tác kết bạn.',
    };
    recordZaloToolResult(cancelMessages[recipientRequest.request.type] || 'Đã hủy thao tác.', recipientRequest);
    setRecipientRequest(null);
  }, [recipientRequest, recordZaloToolResult]);

  const sendToSelectedRecipients = useCallback(async (_messages: any[], targets: ZaloMessageTarget[], message: string) => {
    const context = recipientRequest;
    if (!context || sendingZaloRef.current || scopeRef.current !== context.scope) return;
    // Ref is set synchronously so a double click cannot send a batch twice.
    sendingZaloRef.current = true;
    setSendingZalo(true);
    try {
      const results = await sendSelectedZaloMessages(message, targets, useAccountStore.getState().accounts, async params => {
        if (!ipc.zalo?.sendMessage) throw new Error('Chức năng gửi tin Zalo chưa khả dụng.');
        return ipc.zalo.sendMessage(params);
      }, context.request.id);
      const followUp = results.some(r => r.success && !r.trackingWarning)
        ? 'Bạn có thể hỏi lại để Agent gom phản hồi từ mốc tin đã gửi.'
        : 'Chưa có mốc gửi thành công để thu thập phản hồi.';
      recordZaloToolResult(`${summarizeZaloSendResults(results)}\nMã yêu cầu: ${context.request.id}\n${followUp}\n\nNội dung gửi:\n${message.trim()}`, context);
    } catch (error: any) {
      recordZaloToolResult(`Không thể gửi tin Zalo: ${error.message}`, context);
    } finally {
      sendingZaloRef.current = false;
      if (mountedRef.current) {
        setSendingZalo(false);
        setRecipientRequest(current => current?.request.id === context.request.id ? null : current);
      }
    }
  }, [recipientRequest, recordZaloToolResult]);

  const completeGroupAction = useCallback((text: string) => {
    const context = recipientRequest;
    if (!context) return;
    recordZaloToolResult(text, context);
    setRecipientRequest(null);
  }, [recipientRequest, recordZaloToolResult]);

  const sendQuoteToConfiguredRecipients = useCallback(async (request: AIChatRecipientRequest, conversationReady: Promise<string | null>, turnScope: string) => {
    if (!activeId || !activeAccountId) return;
    const context = { request, conversationReady, scope: turnScope, accountId: activeAccountId };
    try {
      const config = await ipc.ai?.getQuoteRecipients({ assistantId: activeId, accountId: activeAccountId });
      const targets: ZaloMessageTarget[] = (config?.recipients || [])
        .filter((row: any) => Number(row.enabled) === 1 || row.enabled === true)
        .filter((row: any) => String(row.account_id) === activeAccountId && String(row.thread_id || '').trim() && [0, 1].includes(Number(row.thread_type)))
        .map((row: any) => ({ threadId: String(row.thread_id), threadType: Number(row.thread_type), accountId: activeAccountId, displayName: row.display_name }));
      if (!targets.length) {
        recordZaloToolResult('Chưa có nơi hỏi giá mặc định. Hãy bấm Cài đặt nơi hỏi giá để thêm user/nhóm.', context);
        return;
      }
      sendingZaloRef.current = true;
      setSendingZalo(true);
      const results = await sendSelectedZaloMessages(request.message, targets, useAccountStore.getState().accounts, params => ipc.zalo!.sendMessage(params), request.id);
      const sent = results.filter(result => result.success && result.messageId);
      const awaitingConfirmation = results.filter(result => result.success && !result.messageId);
      const failed = results.filter(result => !result.success);
      const outcome = [
        sent.length ? `Đã gửi yêu cầu báo giá tới ${sent.map(result => result.displayName || result.threadId).join(', ')}.` : '',
        awaitingConfirmation.length ? `Đang chờ Zalo xác nhận gửi tới ${awaitingConfirmation.map(result => result.displayName || result.threadId).join(', ')}.` : '',
        ...failed.map(result => `Chưa gửi được tới ${result.displayName || result.threadId}: ${result.error}`),
        sent.some(result => result.trackingWarning) ? 'Chưa lưu được mốc theo dõi cho một số nơi nhận.' : '',
      ].filter(Boolean).join('\n');
      recordZaloToolResult(outcome, context);
    } catch (error: any) { recordZaloToolResult(`Không thể gửi hỏi giá: ${error?.message || 'Lỗi không xác định'}`, context); }
    finally { sendingZaloRef.current = false; setSendingZalo(false); }
  }, [activeId, activeAccountId, recordZaloToolResult]);

  const handleNewConversation = useCallback(async () => {
    if (!activeId || creatingConversation || loading || recipientRequest) return;
    setCreatingConversation(true);
    try {
      const newReady = createPanelConversationId(activeAccountId, activeThreadId, activeId);
      conversationRef.current = { scope, ready: newReady };
      historyRevisionRef.current += 1;
      setMessages([]);
      setRecipientRequest(null);
      const id = await newReady;
      if (!id) throw new Error('Không thể tạo cuộc trò chuyện AI mới');
    } catch (e: any) {
      useAppStore.getState().showNotification(e?.message || 'Không thể tạo chat AI mới', 'error');
    } finally {
      setCreatingConversation(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [activeId, activeAccountId, activeThreadId, creatingConversation, loading, recipientRequest, scope]);

  // The main-process Agent handles the event even when this panel is closed.
  // This listener only renders the already-persisted result; it never calls AI.
  useEffect(() => {
    let cancelled = false;
    setQuoteProcessing(false);
    setQuoteReplyError('');
    const matches = (event: any) => event?.assistantId === activeId
      && event.sourceAccountId === activeAccountId && event.sourceThreadId === activeThreadId;
    const stopProcessing = ipc.on?.('ai:quoteProcessing', (event: any) => {
      if (!matches(event)) return;
      setQuoteProcessing(!!event.processing);
      if (event.processing) setQuoteReplyError('');
      if (event.error) setQuoteReplyError(`Chưa cập nhật được báo giá: ${event.error}. Agent sẽ tự thử lại.`);
    });
    const stopReceived = ipc.on?.('ai:quoteReply', (event: any) => {
      if (matches(event)) { setQuoteProcessing(true); setQuoteReplyError(''); }
    });
    const stopUpdates = ipc.on?.('ai:quoteUpdated', (event: any) => {
      if (!matches(event) || !event.content) return;
      void (async () => {
        const conversationId = await conversationRef.current?.ready;
        if (cancelled || scopeRef.current !== scope || conversationId !== event.conversationId) return;
        const segments = parseStructuredResponse(event.content);
        setMessages(previous => previous.some(message => message.persistedId === event.messageRowId)
          ? previous
          : [...previous, { role: 'assistant', content: event.content, segments: segments || undefined, persistedId: event.messageRowId }]);
      })();
    });
    return () => { cancelled = true; stopProcessing?.(); stopUpdates?.(); stopReceived?.(); };
  }, [activeId, activeAccountId, activeThreadId, scope]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /** Insert AI text vào MessageInput bằng cách dispatch custom event */
  const insertToChat = (text: string) => {
    window.dispatchEvent(new CustomEvent('ai:insertToChat', { detail: { text } }));
  };

  /** Tóm tắt hội thoại: lấy tin nhắn gần đây, gửi AI tóm tắt */
  const handleSummarize = useCallback(async () => {
    if (!activeId || loading) return;
    const zaloContext = getRawZaloChatContext();
    if (!zaloContext) return;
    setLoading(true);
    const summaryPrompt = `Hãy tóm tắt cuộc hội thoại sau trong 3-5 dòng, nêu rõ: chủ đề chính, yêu cầu của khách, trạng thái hiện tại.\n\n${zaloContext}`;
    const userMsg: ChatMsg = { role: 'user', content: 'Tóm tắt hội thoại' };
    setMessages(prev => [...prev, userMsg]);
    try {
      const res = await ipc.ai?.chat(activeId, [{ role: 'user', content: summaryPrompt }]);
      if (res?.success && res.result) {
        setMessages(prev => [...prev, { role: 'assistant', content: res.result! }]);
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${res?.error || 'Không có phản hồi'}` }]);
      }
    } catch (e: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message}` }]);
    }
    setLoading(false);
  }, [activeId, loading, getRawZaloChatContext]);

  const activeAssistant = assistants.find(a => a.id === activeId);
  const canUseZaloContext = !!(activeAccountId && activeThreadId);
  const hasZaloContext = canUseZaloContext && aiAutoInjectZaloContext;

  const applyContextCountInput = useCallback(() => {
    const trimmed = contextCountInput.trim();
    if (!trimmed) {
      setContextCountInput(String(effectiveContextMsgCount));
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setContextCountInput(String(effectiveContextMsgCount));
      return;
    }
    const next = clampContextCount(parsed);
    setAiQuickPanelContextCountOverride(next);
    setContextCountInput(String(next));
  }, [contextCountInput, effectiveContextMsgCount, setAiQuickPanelContextCountOverride]);

  return (
    <div className="w-[330px] h-full flex flex-col bg-gray-800 border-l border-gray-700">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-white flex items-center gap-1.5"><BotIcon className="w-4 h-4 inline" /> Trợ lý AI
          </h2>
          <div className="flex items-center gap-1">
          {activeId && activeAccountId && <button onClick={() => setQuoteRecipientsOpen(true)} className="h-7 px-2 rounded-lg hover:bg-gray-700 text-[11px] text-gray-400 hover:text-white" title="Cài đặt nơi hỏi giá">⚙ Nơi hỏi giá</button>}
          <button onClick={handleNewConversation} disabled={!activeId || creatingConversation || loading || !!recipientRequest}
            className="h-7 px-2 rounded-lg hover:bg-gray-700 flex items-center justify-center text-[11px] text-gray-400 hover:text-white disabled:opacity-40 transition-colors" title="Tạo cuộc trò chuyện AI mới">
            {creatingConversation ? 'Đang tạo...' : '+ Chat mới'}
          </button>
          <button onClick={onClose}
            className="w-7 h-7 rounded-lg hover:bg-gray-700 flex items-center justify-center text-gray-400 hover:text-white transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
          </div>
        </div>

        {/* Assistant selector */}
        {loadingAssistants ? (
          <div className="text-xs text-gray-400">Đang tải...</div>
        ) : assistants.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="text-3xl"><BotIcon className="w-4 h-4" /></div>
            <p className="text-xs text-gray-400 text-center leading-relaxed">
              Chưa có trợ lý AI nào.<br/>Tạo trợ lý để bắt đầu hỗ trợ chat thông minh.
            </p>
            <button
              onClick={() => {
                const { setView, openIntegrationPanelTo } = useAppStore.getState();
                setView('integration');
                openIntegrationPanelTo('ai-assistant', 'list');
                onClose();
              }}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors shadow-lg shadow-blue-900/30"
            >
              <SparklesIcon className="w-4 h-4" /> Tạo trợ lý AI ngay
            </button>
            <div className="w-full pt-1 border-t border-gray-700/60">
              <p className="text-[10px] text-gray-400 text-center mb-2">Nền tảng hỗ trợ</p>
              <div className="flex justify-center gap-3">
                {[<BotIcon className="w-4 h-4" />,<SparklesIcon className="w-4 h-4" />,<HelpCircleIcon className="w-4 h-4" />,<LightningIcon className="w-4 h-4" />].map((icon, idx) => {
                  const names = ['OpenAI','Gemini','DeepSeek','Grok'];
                  return (
                  <div key={names[idx]} className="flex flex-col items-center gap-0.5">
                    <span className="text-base">{icon}</span>
                    <span className="text-[9px] text-gray-400">{names[idx]}</span>
                  </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <select value={activeId} onChange={e => setActiveId(e.target.value)}
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500">
            {assistants.map(a => (
              <option key={a.id} value={a.id}>
                {PLATFORM_ICON_TEXTS[a.platform] || '[AI]'} {a.name} - {a.model}
                {a.isDefault ? ' [Mac dinh]' : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Auto-context indicator + quick actions */}
      {activeId && canUseZaloContext && (
        <div className="px-3 py-2 border-b border-gray-700/50 flex-shrink-0 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 text-sm text-gray-400 min-w-0">
              <span>{hasZaloContext ? 'Ngữ cảnh bật' : 'Ngữ cảnh tắt'}</span>
              <button
                type="button"
                role="switch"
                aria-checked={hasZaloContext}
                onClick={() => setAiAutoInjectZaloContext(!aiAutoInjectZaloContext)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${hasZaloContext ? 'bg-green-600' : 'bg-gray-600 hover:bg-gray-500'}`}
                title={hasZaloContext ? 'Tắt tự động gửi ngữ cảnh Zalo' : 'Bật tự động gửi ngữ cảnh Zalo'}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${hasZaloContext ? 'translate-x-5' : 'translate-x-1'}`}
                />
              </button>
            </div>
            <button
              onClick={handleSummarize}
              disabled={loading || !!recipientRequest || sendingZalo}
              className="text-[12px] px-2 py-0.5 rounded bg-purple-900/60 text-purple-100 hover:bg-purple-800/50 disabled:opacity-40 transition-colors flex-shrink-0"
              title="AI tóm tắt hội thoại hiện tại"
            ><FileTextIcon className="w-4 h-4 inline" /> Tóm tắt
            </button>
          </div>

          {hasZaloContext && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] uppercase tracking-wide text-gray-400">Số ngữ cảnh</span>
              <input
                type="number"
                min={1}
                max={1000}
                step={1}
                value={contextCountInput}
                onChange={(e) => setContextCountInput(e.target.value)}
                onBlur={applyContextCountInput}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyContextCountInput();
                  }
                }}
                className="w-16 bg-gray-800 border border-gray-600 rounded-md px-2 py-1 text-[11px] text-white focus:outline-none focus:border-blue-500"
                title="Số lượng tin nhắn dùng làm ngữ cảnh"
              />
              <span className="text-[11px] text-gray-400">Tối đa 1000 tin</span>
            </div>
          )}
        </div>
      )}

      {quoteProcessing && <div className="px-3 py-2 text-xs text-purple-200" role="status">Đã nhận phản hồi mới, Agent đang cập nhật báo giá...</div>}
      {quoteReplyError && <div className="px-3 py-2 text-xs text-amber-200" role="alert">{quoteReplyError}</div>}
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && activeId && (
          <div className="text-center py-10">
            <p className="text-xs text-gray-400">
              {canUseZaloContext
                ? (hasZaloContext
                    ? 'Hỏi bất kỳ điều gì - trợ lý AI sẽ tự động nắm ngữ cảnh hội thoại Zalo hiện tại'
                    : 'Hỏi bất kỳ điều gì - đang chat với trợ lý AI nội bộ, không tự gửi lịch sử chat Zalo')
                : 'Hỏi bất kỳ điều gì - AI sẽ trả lời dựa trên prompt và dữ liệu đã cấu hình'}
            </p>
          </div>
        )}
        {messages.map((msg, i) => {
          const plainText = msg.segments?.length
            ? msg.segments.filter(segment => segment.type === 'text').map(segment => String(segment.content || '')).join('\n')
            : msg.content;
          const isQuote = msg.role === 'assistant' && (msg.segments?.some(segment => segment.presentation === 'quote')
            || (/báo giá|phản hồi.{0,40}giá/iu.test(plainText) && hasQuoteAmount(plainText)));
          return (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`rounded-xl text-sm leading-relaxed ${isQuote
              ? 'w-full max-w-full overflow-hidden border border-emerald-500/35 bg-slate-900 shadow-lg shadow-emerald-950/30'
              : `max-w-[85%] px-3 py-2 ${msg.role === 'user'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-200 border border-gray-700'}`
            }`}>
              {/* Render structured segments (text + images) or plain text */}
              {isQuote ? <AIQuoteReplyCard text={plainText} /> : msg.segments && msg.segments.length > 0 ? (
                <div className="space-y-2">
                  {msg.segments.map((seg, si) => (
                    seg.type === 'image' && Array.isArray(seg.content) ? (
                      <div key={si} className="flex flex-wrap gap-1.5">
                        {seg.content.map((url: string, ui: number) => (
                          <img key={ui} src={url} alt="" className="max-w-full max-h-32 rounded-lg object-cover border border-gray-600/30"
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        ))}
                      </div>
                    ) : seg.type === 'text' && seg.content ? (
                      <div key={si} className="whitespace-pre-wrap break-words">{seg.content}</div>
                    ) : null
                  ))}
                </div>
              ) : (
                <div className="whitespace-pre-wrap break-words">{msg.content}</div>
              )}
              {msg.role === 'assistant' && !msg.content.startsWith('Error:') && (
                <div className={`flex items-center gap-1.5 border-t ${isQuote ? 'border-emerald-500/15 px-3 py-2' : 'mt-2 pt-1.5 border-gray-700/50'}`}>
                  <button onClick={() => {
                    const textToInsert = msg.segments
                      ? msg.segments.filter(s => s.type === 'text').map(s => s.content).join('\n')
                      : msg.content;
                    insertToChat(textToInsert);
                  }}
                    className="text-[10px] px-2 py-0.5 rounded bg-blue-900/40 text-blue-400 hover:bg-blue-800/50 transition-colors"
                    title="Chèn vào ô chat">
                    <EditIcon className="w-4 h-4 inline" /> Chèn vào chat
                  </button>
                  <button onClick={() => {
                    const textToCopy = msg.segments
                      ? msg.segments.filter(s => s.type === 'text').map(s => s.content).join('\n')
                      : msg.content;
                    navigator.clipboard.writeText(textToCopy);
                  }}
                    className="text-[10px] px-2 py-0.5 rounded bg-gray-700 text-gray-400 hover:text-white transition-colors"
                    title="Copy"><ClipboardListIcon className="w-4 h-4 inline" /> Copy
                  </button>
                </div>
              )}
            </div>
          </div>
          );
        })}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2">
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}/>
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}/>
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}/>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      {activeId && (
        <div className="px-3 pb-3 pt-1 flex-shrink-0">
          <div className="flex items-end gap-2 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2">
            <textarea ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Nhập câu hỏi..."
              rows={1}
              className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 resize-none outline-none max-h-24 overflow-y-auto"
              style={{ minHeight: '1.5rem' }}
            />
            <button onClick={handleSend} disabled={loading || !!recipientRequest || sendingZalo || !input.trim()}
              className="w-7 h-7 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 flex items-center justify-center text-white transition-colors flex-shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
              </svg>
            </button>
          </div>
        </div>
      )}
      {recipientRequest && recipientRequest.scope === scope && recipientRequest.request.type === 'select_zalo_recipients' && (
        <ForwardMessageModal
          key={recipientRequest.request.id}
          mode="ai-send"
          messages={[]}
          allowedChannel="zalo"
          initialAccountId={recipientRequest.accountId || undefined}
          initialComposeText={recipientRequest.request.message}
          submitting={sendingZalo}
          onClose={cancelRecipientSelection}
          onForward={sendToSelectedRecipients}
        />
      )}
      {recipientRequest && recipientRequest.scope === scope && recipientRequest.request.type !== 'select_zalo_recipients' && (
        <AIGroupActionModal
          key={recipientRequest.request.id}
          request={recipientRequest.request}
          onClose={cancelRecipientSelection}
          onComplete={completeGroupAction}
        />
      )}
      {quoteRecipientsOpen && activeId && activeAccountId && <AIQuoteRecipientsModal assistantId={activeId} accountId={activeAccountId} onClose={() => setQuoteRecipientsOpen(false)} />}
    </div>
  );
}
