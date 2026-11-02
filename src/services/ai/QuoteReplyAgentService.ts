import { randomUUID } from 'crypto';
import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';
import WorkspaceManager from '../../utils/WorkspaceManager';
import Logger from '../../utils/Logger';
import ChatZaloTrackingService, { type TrackingDb } from './ChatZaloTrackingService';
import ChatWorkflowAgentService from './ChatWorkflowAgentService';
import { parseStructuredResponse } from '../../utils/aiUtils';

/** Main-process event consumer. Receiving and processing never depend on a mounted panel. */
export default class QuoteReplyAgentService {
  private static instance = new QuoteReplyAgentService();
  static getInstance() { return this.instance; }
  private started = false;
  private running = false;
  private queued = new Map<string, { dbPath: string; taskId: string }>();
  private retryAfter = new Map<string, number>();

  start(): void {
    if (this.started) return;
    this.started = true;
    ChatZaloTrackingService.onQuoteReply(event => {
      if (event.dbPath) this.wake(event.dbPath, event.taskId);
    });
    // Recovery only; live events call wake synchronously, with no polling delay.
    this.recover();
    setInterval(() => this.recover(), 30_000).unref();
  }

  private wake(dbPath: string, taskId: string): void {
    const key = JSON.stringify([dbPath, taskId]);
    this.queued.set(key, { dbPath, taskId });
    Logger.info(`[QuoteReplyAgent] event queued task=${taskId}`);
    void this.drain();
  }

  private recover(): void {
    const database = DatabaseService.getInstance();
    const paths = new Set([database.getDbPath()]);
    const wm = WorkspaceManager.getInstance();
    const defaultWorkspace = wm.getWorkspaceById('default');
    if (defaultWorkspace) paths.add(wm.resolveDbPath(defaultWorkspace.dbPath || 'deplao-tool.db'));
    for (const dbPath of paths) {
      try {
        // Resume only events already received and not completed. Opening the app
        // must not scan historical messages and manufacture new notifications.
        const tasks = database.queryOtherDb(dbPath, db => db.prepare(`SELECT DISTINCT task_id FROM ai_zalo_quote_replies WHERE status = 'pending'`).all());
        for (const task of tasks as any[]) this.wake(dbPath, task.task_id);
      } catch (error: any) {
        Logger.warn(`[QuoteReplyAgent] recovery: ${error.message}`);
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queued.size) {
        const [key, item] = this.queued.entries().next().value!;
        this.queued.delete(key);
        if ((this.retryAfter.get(key) || 0) > Date.now()) continue;
        try {
          await this.process(item.dbPath, item.taskId);
          this.retryAfter.delete(key);
        } catch (error: any) {
          // Leave rows pending on failure/restart. Recovery retries without
          // consuming model tokens in a tight loop.
          this.retryAfter.set(key, Date.now() + 60_000);
          Logger.error(`[QuoteReplyAgent] task=${item.taskId} failed: ${error.message}`);
        }
      }
    } finally { this.running = false; }
  }

  private async process(dbPath: string, taskId: string): Promise<void> {
    const database = DatabaseService.getInstance();
    const snapshot = database.queryOtherDb(dbPath, db => {
      const task = db.prepare('SELECT * FROM ai_zalo_tasks WHERE id = ?').get(taskId) as any;
      const replies = db.prepare(`SELECT r.id, r.content, d.display_name FROM ai_zalo_quote_replies r
        JOIN ai_zalo_deliveries d ON d.id = r.delivery_id
        WHERE r.task_id = ? AND r.status = 'pending' ORDER BY r.created_at, r.rowid LIMIT 200`).all(taskId) as any[];
      if (!task || !replies.length) return null;
      let conversation = db.prepare(`SELECT id FROM ai_conversations WHERE assistant_id = ? AND zalo_id = ? AND thread_id = ? ORDER BY last_message_at DESC LIMIT 1`)
        .get(task.assistant_id, task.source_account_id, task.source_thread_id) as any;
      if (!conversation) {
        const now = Date.now();
        conversation = { id: `aiconv_${randomUUID()}` };
        db.prepare(`INSERT INTO ai_conversations (id, assistant_id, zalo_id, thread_id, title, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(conversation.id, task.assistant_id, task.source_account_id, task.source_thread_id, 'Phản hồi báo giá', now, now, now);
      }
      return { task, replyIds: replies.map(reply => reply.id),
        newReplies: replies.map(reply => ({ name: reply.display_name, content: reply.content })), conversationId: conversation.id };
    });
    if (!snapshot) return;
    const { task, replyIds, newReplies, conversationId } = snapshot;
    const target = { assistantId: task.assistant_id, sourceAccountId: task.source_account_id, sourceThreadId: task.source_thread_id, taskId, conversationId, dbPath };
    EventBroadcaster.emit('ai:quoteProcessing', { ...target, processing: true });
    Logger.info(`[QuoteReplyAgent] processing task=${taskId} replies=${replyIds.length}`);
    try {
      const boundDb: TrackingDb = {
        query: <T = any>(sql: string, params: any[] = []): T[] => database.queryOtherDb(dbPath, db => db.prepare(sql).all(...params) as T[]),
        run: (sql, params = []) => { database.queryOtherDb(dbPath, db => db.prepare(sql).run(...params)); },
        getDbPath: () => dbPath,
      };
      // Only the synchronous configuration capture uses the source workspace.
      // Tool reads and final writes stay bound to its file across every await.
      const response = await database.withDbPath(dbPath, () => ChatWorkflowAgentService.getInstance().runTurn({
        assistantId: task.assistant_id,
        messages: [{ role: 'user', content: `Thông báo ngắn gọn cho người dùng về các phản hồi MỚI sau đây. Không nhắc lại các giá cũ trong bối cảnh. Nếu nhiều tin cùng một nơi nhận thì gộp lại tự nhiên:\n${JSON.stringify(newReplies)}` }],
        triggerData: { zaloId: task.source_account_id, threadId: task.source_thread_id },
        replyTaskId: taskId,
        trackingDb: boundDb,
      }));
      if (!response.result || response.recipientRequest) throw new Error('Agent không trả kết quả tổng hợp chỉ đọc.');
      const segments = parseStructuredResponse(response.result) || [{ type: 'text' as const, content: response.result }];
      const displayResult = JSON.stringify(segments.map(segment => segment.type === 'text'
        ? { ...segment, presentation: 'quote' } : segment));
      const messageRowId = database.queryOtherDb(dbPath, db => db.transaction(() => {
        const now = Date.now();
        const result = db.prepare(`INSERT INTO ai_conversation_messages (conversation_id, role, content, segments_json, created_at) VALUES (?, 'assistant', ?, ?, ?)`)
          .run(conversationId, displayResult, displayResult, now);
        db.prepare('UPDATE ai_conversations SET last_message_at = ?, updated_at = ? WHERE id = ?').run(now, now, conversationId);
        const complete = db.prepare(`UPDATE ai_zalo_quote_replies SET status = 'completed', processed_at = ? WHERE id = ? AND status = 'pending'`);
        for (const id of replyIds) complete.run(now, id);
        return Number(result.lastInsertRowid);
      })());
      EventBroadcaster.emit('ai:quoteUpdated', { ...target, messageRowId, content: displayResult });
      Logger.info(`[QuoteReplyAgent] completed task=${taskId} conversation=${conversationId}`);
      // Catch messages that arrived during inference even if their IPC event
      // was suppressed or the panel was closed.
      const remaining = boundDb.query(`SELECT id FROM ai_zalo_quote_replies WHERE task_id = ? AND status = 'pending' LIMIT 1`, [taskId]);
      if (remaining.length) this.wake(dbPath, taskId);
    } catch (error: any) {
      EventBroadcaster.emit('ai:quoteProcessing', { ...target, processing: false, error: error.message });
      throw error;
    } finally { EventBroadcaster.emit('ai:quoteProcessing', { ...target, processing: false }); }
  }
}
