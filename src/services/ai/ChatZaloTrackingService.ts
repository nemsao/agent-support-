import { randomUUID } from 'crypto';
import type { AIChatRecipientRequest } from '../../models/aiChatTools';
import Logger from '../../utils/Logger';

// Zalo uses webchat for ordinary text (including quoted price replies).
// Only the action payload identifies a webchat system notification.
const SYSTEM_MESSAGE_TYPES = new Set(['system', 'chat.delete', 'chat.reaction', 'chat.ecard']);

export interface TrackingDb {
  run(sql: string, params?: any[]): void;
  query<T = any>(sql: string, params?: any[]): T[];
  getDbPath?(): string;
}

export interface ZaloTrackingScope {
  assistantId: string;
  accountId: string;
  threadId: string;
  threadType?: number;
  allowedAccountIds?: string[];
}

function messageTimestamp(raw: any): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value < 100_000_000_000 ? value * 1000 : value;
}

function isSystemMessageType(raw: any): boolean {
  const type = String(raw || '').toLowerCase();
  return SYSTEM_MESSAGE_TYPES.has(type);
}

function isQuoteReplyCandidate(input: {
  accountId: string; threadId: string; threadType: number; msgId: string; senderId: string;
  msgType: any; timestamp: number; delivery: any; anchor?: any; candidateRow?: any; quoteIds: string[]; content: string;
}): boolean {
  const { accountId, threadId, threadType, msgId, senderId, msgType, timestamp, delivery, anchor, candidateRow, quoteIds, content } = input;
  if (delivery.status !== 'sent' || delivery.account_id !== accountId || delivery.thread_id !== threadId || Number(delivery.thread_type) !== threadType) return false;
  if (!msgId || msgId === String(delivery.message_id || '') || !timestamp || timestamp < Number(anchor?.timestamp ?? delivery.started_at)) return false;
  if (candidateRow && Number(candidateRow.id) <= Number(delivery.baseline_row_id)) return false;
  if (senderId.toLowerCase() === 'system' || isSystemMessageType(msgType)) return false;
  // An explicit reply to the tracked outbound anchor also supports a user
  // testing from their own account; an ordinary self echo never qualifies.
  const anchorIds = [delivery.message_id, anchor?.msg_id, anchor?.cli_msg_id].filter(value => value != null).map(String);
  const quotesAnchor = anchorIds.some(id => quoteIds.includes(id));
  if (quoteIds.length && !quotesAnchor) return false;
  if (content.trim() === String(delivery.message || '').trim()) return false;
  // Some Zalo events expose both isSelf=true and uidFrom=0 for a typed price
  // response. Treat a price/stock signal as a candidate, never as proof that
  // it came from a supplier. Read-only aggregation still attributes its sender.
  const replySignal = /(?:^|\s)\d[\d.,]*\s*(?:tr\b|triệu\b|k\b|nghìn\b|ngàn\b|đ\b|đồng\b|vnd\b|usd\b)|(?:giá|báo giá)\s*[:=]?\s*\d|hết hàng|còn hàng|không có hàng/iu.test(content);
  if ((!senderId || senderId === '0' || senderId === accountId) && !quotesAnchor && !replySignal) return false;
  return true;
}

function readableMessage(row: any) {
  let content = row.is_recalled ? '[Tin nhắn đã thu hồi]' : String(row.content || '');
  if (!row.is_recalled) {
    try {
      const value = JSON.parse(content);
      if (typeof value === 'string') content = value;
      else if (value && typeof value === 'object') content = String(value.msg || value.title || `[${row.msg_type || 'Tin đính kèm'}]`);
    } catch {}
  }
  return {
    rowId: row.id, messageId: row.msg_id, senderId: row.sender_id,
    senderName: row.sender_name || row.sender_id, sentByUs: !!row.is_sent,
    timestamp: row.timestamp, type: row.msg_type, content: content.slice(0, 8000),
    replyCandidate: !!row.is_quote_reply_candidate,
    quote: row.is_recalled ? undefined : row.quote_data,
  };
}

/** Durable outbound anchors; the existing Zalo listener supplies new messages. */
export default class ChatZaloTrackingService {
  private static replyListeners = new Set<(event: any) => void>();

  public static onQuoteReply(listener: (event: any) => void): () => void {
    this.replyListeners.add(listener);
    return () => this.replyListeners.delete(listener);
  }

  public static handleIncomingMessage(db: TrackingDb, accountId: string, message: any): any | undefined {
    const threadId = String(message.threadId || '');
    const threadType = Number(message.type ?? message.data?.type ?? message.data?.threadType ?? 0);
    const msgId = String(message.data?.msgId || '');
    const senderId = String(message.data?.uidFrom || message.data?.senderId || '');
    const msgType = message.data?.msgType;
    const timestamp = messageTimestamp(message.data?.ts);
    const rawContent = message.data?.content ?? message.data?.message ?? '';
    let payload = rawContent;
    if (typeof payload === 'string' && payload.trim().startsWith('{')) {
      try { payload = JSON.parse(payload); } catch {}
    }
    if (payload && typeof payload === 'object' && payload.action === 'msginfo.actionlist') return undefined;
    const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
    const quote = message.data?.quote || {};
    const quoteIds = [quote.globalMsgId, quote.msgId, quote.cliMsgId].filter(value => value != null).map(String);
    // zca-js can mark a genuine group reply as isSelf. uidFrom remains the
    // useful sender identity when supplied. Ambiguous self messages need an
    // explicit anchored quote or a price/stock signal before waking the Agent.
    if (!threadId || !msgId || ![0, 1].includes(threadType) || !timestamp) return undefined;
    if (db.query(`SELECT id FROM ai_zalo_quote_replies WHERE account_id = ? AND thread_id = ? AND thread_type = ? AND message_id = ? LIMIT 1`,
      [accountId, threadId, threadType, msgId]).length) return undefined;
    const deliveries = db.query<any>(`SELECT d.*, t.assistant_id, t.source_account_id, t.source_thread_id FROM ai_zalo_deliveries d JOIN ai_zalo_tasks t ON t.id = d.task_id
      WHERE t.task_type = 'quote' AND d.account_id = ? AND d.thread_id = ? AND d.thread_type = ? AND d.status = 'sent'
      AND d.sent_at IS NOT NULL AND ? >= d.started_at
      ORDER BY d.sent_at DESC LIMIT 20`, [accountId, threadId, threadType, timestamp]);
    for (const delivery of deliveries) {
      const anchor = delivery.message_id ? db.query<any>(`SELECT id, timestamp, msg_id, cli_msg_id FROM messages
        WHERE owner_zalo_id = ? AND thread_id = ? AND thread_type = ? AND (msg_id = ? OR cli_msg_id = ?) LIMIT 1`,
      [accountId, threadId, threadType, delivery.message_id, delivery.message_id])[0] : undefined;
      const candidateRow = db.query<any>(`SELECT id FROM messages
        WHERE owner_zalo_id = ? AND thread_id = ? AND thread_type = ? AND (msg_id = ? OR cli_msg_id = ?) LIMIT 1`,
      [accountId, threadId, threadType, msgId, msgId])[0];
      if (!isQuoteReplyCandidate({ accountId, threadId, threadType, msgId, senderId, msgType, timestamp, delivery, anchor, candidateRow, quoteIds, content })) continue;
      const duplicate = db.query(`SELECT id FROM ai_zalo_quote_replies WHERE delivery_id = ? AND message_id = ? LIMIT 1`, [delivery.id, msgId]);
      if (duplicate.length) continue;
      const replyId = randomUUID();
      db.run(`INSERT OR IGNORE INTO ai_zalo_quote_replies
        (id, assistant_id, task_id, delivery_id, account_id, thread_id, thread_type, message_id, sender_id, message_timestamp, content, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [replyId, delivery.assistant_id, delivery.task_id, delivery.id, accountId, threadId, threadType, msgId, senderId, timestamp, content.slice(0, 12000), Date.now()]);
      const inserted = db.query<any>(`SELECT id FROM ai_zalo_quote_replies WHERE delivery_id = ? AND message_id = ? AND status = 'pending' LIMIT 1`, [delivery.id, msgId])[0];
      if (!inserted) continue;
      const event = { id: inserted.id, taskId: delivery.task_id, deliveryId: delivery.id, assistantId: delivery.assistant_id,
        sourceAccountId: delivery.source_account_id, sourceThreadId: delivery.source_thread_id,
        accountId, threadId, threadType, messageId: msgId, timestamp, senderId, dbPath: db.getDbPath?.() };
      Logger.info(`[ChatZaloTracking] reply accepted task=${delivery.task_id} message=${msgId} type=${msgType} listeners=${this.replyListeners.size}`);
      for (const listener of this.replyListeners) {
        try { listener(event); }
        catch (error: any) { Logger.error(`[ChatZaloTracking] reply listener failed task=${delivery.task_id}: ${error.message}`); }
      }
      return event;
    }
    return undefined;
  }

  public static getPendingQuoteReplies(db: TrackingDb, scope: ZaloTrackingScope, limit = 100): any[] {
    if (scope.allowedAccountIds && !scope.allowedAccountIds.includes(scope.accountId)) return [];
    return db.query<any>(`SELECT r.id, r.task_id AS taskId, r.delivery_id AS deliveryId,
        r.account_id AS accountId, r.thread_id AS threadId, r.thread_type AS threadType,
        r.message_id AS messageId, r.sender_id AS senderId, r.message_timestamp AS timestamp,
        r.content, t.source_account_id AS sourceAccountId, t.source_thread_id AS sourceThreadId
      FROM ai_zalo_quote_replies r JOIN ai_zalo_tasks t ON t.id = r.task_id
      WHERE r.assistant_id = ? AND r.status = 'pending'
        AND t.source_account_id = ? AND t.source_thread_id = ?
      ORDER BY r.created_at, r.rowid LIMIT ?`, [scope.assistantId, scope.accountId, scope.threadId, Math.min(200, Math.max(1, limit))]);
  }

  public static completeQuoteReplies(db: TrackingDb, scope: ZaloTrackingScope, replyIds: string[]): number {
    if (scope.allowedAccountIds && !scope.allowedAccountIds.includes(scope.accountId)) return 0;
    const ids = [...new Set(replyIds.map(String).filter(Boolean))].slice(0, 200);
    let updated = 0;
    for (const id of ids) {
      const row = db.query<any>(`SELECT r.id FROM ai_zalo_quote_replies r JOIN ai_zalo_tasks t ON t.id = r.task_id
        WHERE r.id = ? AND r.assistant_id = ? AND t.source_account_id = ? AND t.source_thread_id = ? AND r.status = 'pending'`,
      [id, scope.assistantId, scope.accountId, scope.threadId])[0];
      if (!row) continue;
      db.run(`UPDATE ai_zalo_quote_replies SET status = 'completed', processed_at = ? WHERE id = ? AND status = 'pending'`, [Date.now(), id]);
      updated++;
    }
    return updated;
  }

  constructor(private db: TrackingDb) {}

  stage(request: AIChatRecipientRequest, scope: ZaloTrackingScope, instruction: string): void {
    this.db.run(`INSERT INTO ai_zalo_tasks
      (id, assistant_id, source_account_id, source_thread_id, task_type, instruction, draft, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [request.id, scope.assistantId, scope.accountId, scope.threadId,
      request.type === 'send_quote_to_configured_recipients' ? 'quote' : 'message',
      instruction.slice(0, 12000), request.message, Date.now()]);
  }

  beginSend(taskId: string, accountId: string, threadId: string, threadType: number, message: string, displayName = ''): string {
    if (!this.db.query('SELECT id FROM ai_zalo_tasks WHERE id = ?', [taskId]).length) {
      throw new Error('Không tìm thấy yêu cầu gửi của Agent. Hãy tạo lại yêu cầu trong Chat.');
    }
    if (!threadId || ![0, 1].includes(threadType) || !message.trim()) throw new Error('Tin nhắn hoặc người nhận không hợp lệ.');
    if (this.db.query('SELECT id FROM ai_zalo_deliveries WHERE task_id = ? AND account_id = ? AND thread_id = ? AND thread_type = ?',
      [taskId, accountId, threadId, threadType]).length) {
      throw new Error('Yêu cầu này đã được thực hiện cho người nhận đã chọn; không gửi lặp lại.');
    }
    const baseline = this.db.query<any>('SELECT MAX(id) AS id FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND thread_type = ?',
      [accountId, threadId, threadType])[0]?.id || 0;
    const id = randomUUID();
    this.db.run(`INSERT INTO ai_zalo_deliveries
      (id, task_id, account_id, thread_id, thread_type, display_name, message, baseline_row_id, started_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending')`,
    [id, taskId, accountId, threadId, threadType, displayName.slice(0, 200), message, baseline, Date.now()]);
    return id;
  }

  finishSend(deliveryId: string, response: any): void {
    const messageId = response?.message?.msgId ?? response?.msgId;
    this.db.run(`UPDATE ai_zalo_deliveries SET status = 'sent', message_id = ?, sent_at = ? WHERE id = ?`,
      [messageId == null ? null : String(messageId), Date.now(), deliveryId]);
    // A fast reply can arrive before the send API resolves. Reconsider those
    // already-saved rows once the outbound ID/status are known.
    const delivery = this.db.query<any>('SELECT * FROM ai_zalo_deliveries WHERE id = ?', [deliveryId])[0];
    if (!delivery) return;
    const rows = this.db.query<any>(`SELECT * FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND thread_type = ?
      AND id > ? AND timestamp >= ? ORDER BY id LIMIT 200`,
    [delivery.account_id, delivery.thread_id, delivery.thread_type, delivery.baseline_row_id, delivery.started_at]);
    for (const row of rows) {
      let quote: any;
      try { quote = row.quote_data ? JSON.parse(row.quote_data) : undefined; } catch {}
      ChatZaloTrackingService.handleIncomingMessage(this.db, delivery.account_id, {
        threadId: delivery.thread_id, type: delivery.thread_type,
        data: { msgId: row.msg_id, uidFrom: row.sender_id, msgType: row.msg_type, ts: row.timestamp, content: row.content, quote },
      });
    }
  }

  failSend(deliveryId: string, error: string): void {
    this.db.run(`UPDATE ai_zalo_deliveries SET status = 'failed', error = ? WHERE id = ?`, [error, deliveryId]);
  }

  private scopedTasks(scope: ZaloTrackingScope, taskId?: string, limit = 10): any[] {
    if (scope.allowedAccountIds && scope.accountId && !scope.allowedAccountIds.includes(scope.accountId)) return [];
    const tasks = this.db.query<any>(`SELECT t.* FROM ai_zalo_tasks t
      WHERE t.assistant_id = ? AND (
        (t.source_account_id = ? AND t.source_thread_id = ?) OR EXISTS (
          SELECT 1 FROM ai_zalo_deliveries d WHERE d.task_id = t.id AND d.account_id = ? AND d.thread_id = ?))
      ${taskId ? 'AND t.id = ?' : 'AND EXISTS (SELECT 1 FROM ai_zalo_deliveries d WHERE d.task_id = t.id)'}
      ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`,
    [scope.assistantId, scope.accountId, scope.threadId, scope.accountId, scope.threadId, ...(taskId ? [taskId] : []), limit]);
    return tasks;
  }

  private deliveries(taskId: string, scope: ZaloTrackingScope): any[] {
    return this.db.query<any>('SELECT * FROM ai_zalo_deliveries WHERE task_id = ? ORDER BY started_at, rowid', [taskId])
      .filter(d => !scope.allowedAccountIds || scope.allowedAccountIds.includes(d.account_id));
  }

  listTasks(scope: ZaloTrackingScope, limit = 10) {
    return this.scopedTasks(scope, undefined, limit).map(task => {
      const recipients = this.deliveries(task.id, scope).map(d => ({
        deliveryId: d.id, accountId: d.account_id, threadId: d.thread_id, threadType: d.thread_type,
        name: d.display_name || d.thread_id, status: d.status, messageId: d.message_id,
        sentAt: d.sent_at, message: d.message, error: d.error,
        replyCount: this.db.query<any>('SELECT COUNT(*) AS count FROM ai_zalo_quote_replies WHERE delivery_id = ?', [d.id])[0]?.count || 0,
      }));
      const sent = recipients.filter(recipient => recipient.status === 'sent');
      const replied = sent.filter(recipient => recipient.replyCount > 0);
      const failed = recipients.some(recipient => recipient.status === 'failed');
      const status = recipients.some(recipient => recipient.status === 'sending') ? 'sending'
        : sent.length === 0 ? 'failed'
          : failed ? 'partial_send'
            : replied.length === 0 ? 'waiting_for_reply'
              : replied.length === sent.length ? 'completed' : 'partial_replies';
      return { taskId: task.id, taskType: task.task_type, instruction: task.instruction, draft: task.draft, createdAt: task.created_at, status, recipients };
    }).filter(task => task.recipients.length > 0);
  }

  readReplies(scope: ZaloTrackingScope, options: {
    taskId?: string; deliveryId?: string; limit?: number; after?: { timestamp: number; rowId: number };
  } = {}) {
    const task = this.scopedTasks(scope, options.taskId, 1)[0];
    if (!task) return { error: 'Chưa có lượt gửi được theo dõi trong Chat này, hoặc bạn không có quyền truy cập.' };
    if (options.after && !options.deliveryId) return { error: 'Cần deliveryId khi đọc trang phản hồi tiếp theo.' };
    const limit = Math.max(1, Math.min(200, options.limit || 100));
    const recipients = this.deliveries(task.id, scope).filter(d => !options.deliveryId || d.id === options.deliveryId).map(d => {
      const base = { deliveryId: d.id, name: d.display_name || d.thread_id, accountId: d.account_id,
        threadId: d.thread_id, threadType: d.thread_type, status: d.status, sentMessage: d.message, messageId: d.message_id };
      if (d.status !== 'sent') return { ...base, error: d.error || 'Chưa xác nhận gửi thành công.', messages: [] };
      const anchor = d.message_id ? this.db.query<any>(`SELECT id, timestamp FROM messages
        WHERE owner_zalo_id = ? AND thread_id = ? AND thread_type = ? AND (msg_id = ? OR cli_msg_id = ?) LIMIT 1`,
      [d.account_id, d.thread_id, d.thread_type, d.message_id, d.message_id])[0] : undefined;
      const since = anchor?.timestamp ?? d.started_at;
      const after = options.after;
      const rows = this.db.query<any>(`SELECT m.*, c.display_name AS sender_name,
        EXISTS(SELECT 1 FROM ai_zalo_quote_replies r WHERE r.delivery_id = ? AND r.message_id = m.msg_id) AS is_quote_reply_candidate FROM messages m
        LEFT JOIN contacts c ON c.owner_zalo_id = m.owner_zalo_id AND c.contact_id = m.sender_id
        WHERE m.owner_zalo_id = ? AND m.thread_id = ? AND m.thread_type = ?
        AND m.id > ? AND m.timestamp >= ? AND m.msg_id <> ? AND COALESCE(m.cli_msg_id, '') <> ?
        ${after ? 'AND (m.timestamp > ? OR (m.timestamp = ? AND m.id > ?))' : ''}
        ORDER BY m.timestamp ASC, m.id ASC LIMIT ?`,
      [d.id, d.account_id, d.thread_id, d.thread_type, d.baseline_row_id, since, d.message_id || '', d.message_id || '',
        ...(after ? [after.timestamp, after.timestamp, after.rowId] : []), limit + 1]);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return { ...base, since, boundary: anchor ? 'sent_message' : 'send_time_fallback',
        messages: page.map(readableMessage), hasMore: rows.length > limit,
        nextCursor: rows.length > limit && last ? { timestamp: last.timestamp, rowId: last.id } : undefined,
        receivedCount: page.filter(m => !m.is_sent).length };
    });
    return { taskId: task.id, instruction: task.instruction, recipients, collectedAt: Date.now(),
      note: 'Đây là các tin đã được app đồng bộ sau mốc gửi, không phải mọi tin đều là phản hồi cho yêu cầu. Dùng nội dung và trích dẫn để xác định liên quan. Ảnh/file chưa được bóc tách thì không suy đoán giá.' };
  }

  readCurrentChat(scope: ZaloTrackingScope, limit = 50) {
    if (!scope.accountId || !scope.threadId) return { error: 'Chưa mở hội thoại Zalo. Hãy dùng nội dung trong Chat với người dùng.' };
    if (scope.allowedAccountIds && !scope.allowedAccountIds.includes(scope.accountId)) return { error: 'Không có quyền đọc tài khoản này.' };
    const typeFilter = scope.threadType === undefined ? '' : ' AND m.thread_type = ?';
    const rows = this.db.query<any>(`SELECT m.*, c.display_name AS sender_name FROM messages m
      LEFT JOIN contacts c ON c.owner_zalo_id = m.owner_zalo_id AND c.contact_id = m.sender_id
      WHERE m.owner_zalo_id = ? AND m.thread_id = ?${typeFilter} ORDER BY m.timestamp DESC, m.id DESC LIMIT ?`,
    [scope.accountId, scope.threadId, ...(scope.threadType === undefined ? [] : [scope.threadType]), Math.min(100, Math.max(1, limit))]);
    return { accountId: scope.accountId, threadId: scope.threadId, messages: rows.reverse().map(readableMessage) };
  }
}
