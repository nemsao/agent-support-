import { createChatZaloTools } from '../services/ai/ChatZaloTools';
import { sendSelectedZaloMessages, summarizeZaloSendResults } from '../utils/zaloMessageTools';

describe('Chat Zalo popup tools', () => {
  const createTools = () => createChatZaloTools(definition => definition);

  it('stages one popup without sending, even when both tools are called', async () => {
    const staged = createTools();
    expect(staged.getRequest()).toBeUndefined();
    const first = await staged.tools.send_zalo_messages.execute({ message: '  Xin giá 100 sản phẩm X  ' });
    const second = await staged.tools.select_zalo_recipients.execute({ message: 'Nội dung khác' });
    expect(first.status).toBe('awaiting_user_selection');
    expect(second.requestId).toBe(first.requestId);
    expect(staged.getRequest()).toEqual({
      id: first.requestId, type: 'select_zalo_recipients', message: 'Xin giá 100 sản phẩm X',
    });
  });

  it('allows selecting recipients before composing, but rejects empty send requests', () => {
    const { tools } = createTools();
    expect(tools.select_zalo_recipients.inputSchema.parse({})).toEqual({ message: '' });
    expect(tools.send_zalo_messages.inputSchema.safeParse({ message: '  ' }).success).toBe(false);
    expect(tools.send_zalo_messages.inputSchema.safeParse({ message: 'a'.repeat(10001) }).success).toBe(false);
  });

  it('creates a new neutral quote draft instead of reusing old wording', async () => {
    const staged = createTools();
    const result = await staged.tools.prepare_quote_request.execute({
      productName: 'sản phẩm X', quantity: '50', unit: 'cái',
    });
    expect(staged.getRequest()?.message).toBe(
      'Có khách cần báo giá sản phẩm X, số lượng 50 cái.\n\nBáo giúp giá.',
    );
    expect(staged.getRequest()?.message).not.toContain('Địa điểm nhận hàng');
    expect(staged.getRequest()?.message).not.toContain('Hóa đơn');
    expect(result.status).toBe('awaiting_user_selection');
  });

  it('stages group and friend actions for the popup without executing them', async () => {
    const staged = createTools();
    const create = await staged.tools.create_zalo_group.execute({ name: 'Khách VIP' });
    expect(create.status).toBe('awaiting_user_selection');
    expect(staged.getRequest()).toMatchObject({ type: 'create_zalo_group', groupName: 'Khách VIP' });

    const second = await staged.tools.remove_zalo_group_members.execute({ groupName: 'Nhóm khác' });
    expect(second.requestId).toBe(create.requestId);
    expect(staged.tools.add_zalo_group_members).toBeDefined();
    expect(staged.tools.send_zalo_friend_requests).toBeDefined();
  });

  it('persists the outbound request once before exposing a selectable popup', async () => {
    const persist = jest.fn();
    const staged = createChatZaloTools(definition => definition, persist);
    await staged.tools.send_zalo_messages.execute({ message: 'Hỏi giá từ ngữ cảnh Chat' });
    await staged.tools.send_zalo_messages.execute({ message: 'Lặp' });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(staged.getRequest());
  });
});

describe('sending to the popup selection', () => {
  const accounts = [
    { zalo_id: 'sender-1', channel: 'zalo', cookies: 'cookies-1', imei: 'imei-1', user_agent: 'ua-1' },
    { zalo_id: 'sender-2', channel: 'zalo', cookies: 'cookies-2' },
    { zalo_id: 'facebook-1', channel: 'facebook' },
  ];
  const user = { threadId: 'user-1', threadType: 0, accountId: 'sender-1', displayName: 'NCC A' };
  const group = { threadId: 'group-1', threadType: 1, accountId: 'sender-2', displayName: 'Nhóm NCC B' };

  it('sends the edited text only to selected destinations, with the selected sender and correct type', async () => {
    const send = jest.fn().mockResolvedValue({ success: true });
    const results = await sendSelectedZaloMessages('  Tin đã chỉnh sửa\nVAT và ship?  ', [user, group, user], accounts, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toEqual({
      auth: { accountId: 'sender-1', cookies: 'cookies-1', imei: 'imei-1', userAgent: 'ua-1' },
      strictAccountId: true, zaloId: 'sender-1', threadId: 'user-1', type: 0, message: 'Tin đã chỉnh sửa\nVAT và ship?',
    });
    expect(send.mock.calls[1][0]).toMatchObject({ auth: { accountId: 'sender-2' }, threadId: 'group-1', type: 1 });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.success)).toBe(true);
  });

  it('does not dispatch invalid, empty or cancelled selections', async () => {
    const send = jest.fn();
    await expect(sendSelectedZaloMessages(' ', [user], accounts, send)).rejects.toThrow('nội dung');
    await expect(sendSelectedZaloMessages('Tin', [], accounts, send)).rejects.toThrow('ít nhất');
    const results = await sendSelectedZaloMessages('Tin', [
      { ...user, accountId: 'missing' },
      { ...group, accountId: 'facebook-1' },
      { ...user, threadId: '' },
      { ...user, threadType: 42 },
    ], accounts, send);
    expect(send).not.toHaveBeenCalled();
    expect(results.every(r => !r.success)).toBe(true);
  });

  it('passes a durable task ID through IPC and retains the server message ID', async () => {
    const send = jest.fn().mockResolvedValue({ success: true, response: { message: { msgId: 'server-message-id' } } });
    const results = await sendSelectedZaloMessages('Hỏi giá', [group], accounts, send, 'task-123');
    expect(send.mock.calls[0][0]).toMatchObject({
      zaloId: 'sender-2', aiChatRequestId: 'task-123', aiChatDisplayName: 'Nhóm NCC B',
    });
    expect(results[0]).toMatchObject({ taskId: 'task-123', messageId: 'server-message-id' });
  });

  it('continues after a failure and reports IPC failure, thrown error and missing response accurately', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce({ success: false, error: 'Chưa kết nối' })
      .mockRejectedValueOnce(new Error('Mất kết nối'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ success: true });
    const targets = [user, group, { ...user, threadId: 'user-3' }, { ...group, threadId: 'group-4' }];
    const results = await sendSelectedZaloMessages('Hỏi giá', targets, accounts, send);
    expect(send).toHaveBeenCalledTimes(4);
    expect(results.map(r => r.success)).toEqual([false, false, false, true]);
    const summary = summarizeZaloSendResults(results);
    expect(summary).toContain('1/4 thành công, 3 thất bại');
    expect(summary).toContain('NCC A: Chưa kết nối');
    expect(summary).toContain('Nhóm NCC B: Mất kết nối');
  });
});
