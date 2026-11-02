import ChatZaloTrackingService, { type ZaloTrackingScope } from '../services/ai/ChatZaloTrackingService';
import { AI_ZALO_TRACKING_SCHEMA } from '../services/database/aiZaloTrackingSchema';

// Node's SQLite runs the production queries without Electron/native ABI coupling.
const { DatabaseSync } = require('node:sqlite');

describe('durable Zalo request anchors and follow-up collection', () => {
  let sql: any;
  let db: any;
  let tracking: ChatZaloTrackingService;
  const scope: ZaloTrackingScope = { assistantId: 'assistant', accountId: 'source', threadId: 'chat' };
  const addMessage = (id: string, timestamp: number, content: string, overrides: any = {}) => {
    const row = { msg_id: id, owner_zalo_id: 'sender', thread_id: 'group', thread_type: 1,
      sender_id: 'supplier', timestamp, content, is_sent: 0, msg_type: 'text', cli_msg_id: null, is_recalled: 0, quote_data: null, ...overrides };
    const keys = Object.keys(row);
    sql.prepare(`INSERT INTO messages (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  };
  const stage = (id = 'task') => tracking.stage({ id, type: 'select_zalo_recipients', message: 'Xin giá 100 SP X, VAT và ship' }, scope, 'Hỏi giá từ chat');

  beforeEach(() => {
    sql = new DatabaseSync(':memory:');
    sql.exec(AI_ZALO_TRACKING_SCHEMA);
    sql.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT, cli_msg_id TEXT,
      owner_zalo_id TEXT, thread_id TEXT, thread_type INTEGER, sender_id TEXT,
      content TEXT, msg_type TEXT, timestamp INTEGER, is_sent INTEGER, is_recalled INTEGER, quote_data TEXT);
      CREATE TABLE contacts(owner_zalo_id TEXT, contact_id TEXT, display_name TEXT);`);
    db = { run: (query: string, params: any[] = []) => sql.prepare(query).run(...params),
      query: (query: string, params: any[] = []) => sql.prepare(query).all(...params) };
    tracking = new ChatZaloTrackingService(db);
  });
  afterEach(() => sql.close());

  it('collects only the selected conversation after the actual outbound anchor, including a fast reply', () => {
    stage();
    addMessage('old', 900, 'Giá cũ 10k');
    addMessage('old-same-time', 1000, 'Tin có sẵn trước khi gửi');
    const deliveryId = tracking.beginSend('task', 'sender', 'group', 1, 'Nội dung đã sửa', 'NCC A');
    // A reply can be persisted before the outgoing self-listener event arrives.
    addMessage('reply-fast', 1000, '100k, chưa VAT');
    addMessage('anchor', 1000, 'Nội dung đã sửa', { is_sent: 1, sender_id: 'sender' });
    addMessage('reply-ship', 1001, 'Ship 30k');
    addMessage('late-history', 800, 'Lịch sử cũ đồng bộ trễ');
    addMessage('other-thread', 1002, 'Không liên quan', { thread_id: 'other' });
    addMessage('other-account', 1002, 'Không liên quan', { owner_zalo_id: 'other' });
    addMessage('other-type', 1002, 'Không liên quan', { thread_type: 0 });
    tracking.finishSend(deliveryId, { message: { msgId: 'anchor' } });
    const result: any = tracking.readReplies(scope);
    expect(result.recipients[0].messages.map((m: any) => m.messageId)).toEqual(['reply-fast', 'reply-ship']);
    expect(result.recipients[0]).toMatchObject({ boundary: 'sent_message', receivedCount: 2, sentMessage: 'Nội dung đã sửa' });
  });

  it('retains anchors across service restarts and separates multiple requests to the same group', () => {
    stage();
    const first = tracking.beginSend('task', 'sender', 'group', 1, 'Hỏi lần 1');
    addMessage('anchor-1', 1000, 'Hỏi lần 1', { is_sent: 1 });
    addMessage('reply-1', 1001, 'Giá lần 1');
    tracking.finishSend(first, { message: { msgId: 'anchor-1' } });
    stage('task-2');
    const second = tracking.beginSend('task-2', 'sender', 'group', 1, 'Hỏi lần 2');
    addMessage('anchor-2', 2000, 'Hỏi lần 2', { is_sent: 1 });
    addMessage('reply-2', 2001, 'Giá lần 2');
    tracking.finishSend(second, { message: { msgId: 'anchor-2' } });
    const restarted = new ChatZaloTrackingService(db);
    expect(restarted.listTasks(scope).map(t => t.taskId)).toEqual(['task-2', 'task']);
    expect((restarted.readReplies(scope) as any).recipients[0].messages.map((m: any) => m.messageId)).toEqual(['reply-2']);
    expect((restarted.readReplies(scope, { taskId: 'task' }) as any).recipients[0].messageId).toBe('anchor-1');
  });

  it('paginates tied timestamps without losing or duplicating messages', () => {
    stage();
    const id = tracking.beginSend('task', 'sender', 'group', 1, 'Hỏi giá');
    addMessage('anchor', 1000, 'Hỏi giá', { is_sent: 1 });
    for (let i = 0; i < 5; i++) addMessage(`reply-${i}`, 1001, `Tin ${i}`);
    tracking.finishSend(id, { message: { msgId: 'anchor' } });
    const first: any = tracking.readReplies(scope, { limit: 2 });
    const second: any = tracking.readReplies(scope, { deliveryId: id, limit: 2, after: first.recipients[0].nextCursor });
    const third: any = tracking.readReplies(scope, { deliveryId: id, limit: 2, after: second.recipients[0].nextCursor });
    expect([first, second, third].flatMap(p => p.recipients[0].messages.map((m: any) => m.messageId)))
      .toEqual(['reply-0', 'reply-1', 'reply-2', 'reply-3', 'reply-4']);
    expect(third.recipients[0].hasMore).toBe(false);
  });

  it('does not expose tasks or messages outside the Chat scope or assigned accounts', () => {
    stage();
    const id = tracking.beginSend('task', 'sender', 'group', 1, 'Hỏi giá');
    tracking.finishSend(id, { message: { msgId: 'anchor' } });
    expect(tracking.listTasks({ ...scope, threadId: 'unrelated' })).toEqual([]);
    expect(tracking.readReplies({ ...scope, assistantId: 'other' }, { taskId: 'task' })).toHaveProperty('error');
    expect((tracking.readReplies({ ...scope, allowedAccountIds: ['source'] }) as any).recipients).toEqual([]);
    expect(tracking.readCurrentChat({ ...scope, allowedAccountIds: [] })).toHaveProperty('error');
    // Opening the actual destination also makes that request discoverable.
    expect(tracking.listTasks({ ...scope, accountId: 'sender', threadId: 'group' })).toHaveLength(1);
  });

  it('excludes failed sends, prevents duplicate dispatch and hides recalled content', () => {
    stage();
    const failed = tracking.beginSend('task', 'sender', 'user', 0, 'Hỏi giá');
    tracking.failSend(failed, 'Không gửi được');
    expect(() => tracking.beginSend('task', 'sender', 'user', 0, 'Hỏi lại')).toThrow('không gửi lặp');
    const sent = tracking.beginSend('task', 'sender', 'group', 1, 'Hỏi giá');
    addMessage('anchor', 1000, 'Hỏi giá', { is_sent: 1 });
    addMessage('recalled', 1001, 'Giá bí mật đã thu hồi', { is_recalled: 1, quote_data: 'Giá bí mật' });
    tracking.finishSend(sent, { message: { msgId: 'anchor' } });
    const result: any = tracking.readReplies(scope);
    expect(result.recipients[0]).toMatchObject({ status: 'failed', messages: [] });
    expect(result.recipients[1].messages[0].content).toBe('[Tin nhắn đã thu hồi]');
    expect(JSON.stringify(result)).not.toContain('Giá bí mật');
  });

  it('uses an explicit time fallback if the sent self-event has not been synced yet', () => {
    stage();
    const id = tracking.beginSend('task', 'sender', 'group', 1, 'Hỏi giá');
    const started = db.query('SELECT started_at FROM ai_zalo_deliveries WHERE id = ?', [id])[0].started_at;
    addMessage('older', started - 1, 'Giá cũ');
    addMessage('new', started + 1, 'Giá mới');
    tracking.finishSend(id, { message: { msgId: 'not-synced' } });
    const result: any = tracking.readReplies(scope);
    expect(result.recipients[0].boundary).toBe('send_time_fallback');
    expect(result.recipients[0].messages.map((m: any) => m.messageId)).toEqual(['new']);
  });

  it('treats a group message as a quote reply even when the platform marks isSelf=true', () => {
    stage();
    const deliveryId = tracking.beginSend('task', 'sender', 'group', 1, 'Hỏi giá');
    addMessage('anchor', 1000, 'Hỏi giá', { is_sent: 1 });
    tracking.finishSend(deliveryId, { message: { msgId: 'anchor' } });
    const replies: any[] = [];
    const unsubscribe = ChatZaloTrackingService.onQuoteReply(event => replies.push(event));
    const event = ChatZaloTrackingService.handleIncomingMessage(db, 'sender', {
      isSelf: true,
      type: 1,
      threadId: 'group',
      data: { msgId: 'reply-platform-self', ts: '1001', content: '50tr ạ' },
    });
    unsubscribe();
    expect(event).toMatchObject({ taskId: 'task', deliveryId, messageId: 'reply-platform-self', content: '50tr ạ' });
    expect(replies).toHaveLength(1);
  });
});
