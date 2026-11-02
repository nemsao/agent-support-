const mockGenerateText = jest.fn();
const mockExecuteWorkflow = jest.fn();

jest.mock('ai', () => ({
  tool: (definition: any) => definition,
  stepCountIs: () => () => false,
  generateText: (...args: any[]) => mockGenerateText(...args),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible: jest.fn() }));
jest.mock('../services/database/DatabaseService', () => ({
  __esModule: true, default: { getInstance: () => ({ getWorkflows: () => [], run: jest.fn(), query: () => [] }) },
}));
jest.mock('../utils/Logger', () => ({ __esModule: true, default: { info: jest.fn() } }));
jest.mock('../services/ai/AIConfigService', () => ({
  __esModule: true, default: { getInstance: () => ({ resolveAssistant: () => ({ platform: 'test', model: 'test' }) }) },
}));
jest.mock('../services/ai/AIAssistantService', () => ({
  __esModule: true, default: { getInstance: () => ({
    getAssistant: () => ({ id: 'assistant', enabled: true }),
    getSystemPrompt: async () => 'Trợ lý thử nghiệm',
  }) },
}));
jest.mock('../services/ai/AiSdkProviderFactory', () => ({
  createSdkModel: () => ({ model: {}, maxDuration: 1000 }),
}));
jest.mock('../services/workflow/WorkflowEngineService', () => ({
  __esModule: true, default: { getInstance: () => ({ executeWorkflow: mockExecuteWorkflow }) },
}));

import ChatWorkflowAgentService from '../services/ai/ChatWorkflowAgentService';

describe('Chat Agent Zalo tool integration', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a real popup request and stops the agent without claiming delivery or running a workflow', async () => {
    mockGenerateText.mockImplementation(async (options: any) => {
      expect(options.tools.list_workflows).toBeUndefined();
      expect(options.tools.get_workflow_inputs).toBeUndefined();
      expect(options.tools.run_workflow).toBeUndefined();
      expect(options.tools.select_zalo_recipients).toBeDefined();
      expect(options.tools.get_zalo_replies).toBeDefined();
      expect(options.tools.list_zalo_tasks).toBeDefined();
      expect(options.tools.create_zalo_group).toBeDefined();
      expect(options.tools.add_zalo_group_members).toBeDefined();
      expect(options.tools.remove_zalo_group_members).toBeDefined();
      expect(options.tools.send_zalo_friend_requests).toBeDefined();
      expect(options.tools.prepare_quote_request).toBeDefined();
      expect(options.tools.insert_zalo_chat_reply).toBeDefined();
      expect(options.tools.open_new_zalo_chat).toBeUndefined();
      expect(options.stopWhen.some((stop: any) => stop({ steps: [] }))).toBe(false);
      const input = options.tools.send_zalo_messages.inputSchema.parse({ message: 'Xin báo giá 100 sản phẩm X, VAT và ship.' });
      await options.tools.send_zalo_messages.execute(input);
      expect(options.stopWhen.some((stop: any) => stop({ steps: [] }))).toBe(true);
      return { text: 'Đã gửi thành công!', usage: { totalTokens: 10 }, steps: [] };
    });
    const result = await ChatWorkflowAgentService.getInstance().runTurn({
      assistantId: 'assistant', messages: [{ role: 'user', content: 'Gửi hỏi giá 100 sản phẩm X đến nhóm tôi chọn' }],
    });
    expect(result.recipientRequest).toMatchObject({ type: 'select_zalo_recipients', message: 'Xin báo giá 100 sản phẩm X, VAT và ship.' });
    expect(JSON.parse(result.result)[0].content).toContain('bấm Chạy');
    expect(result.result).not.toContain('Đã gửi thành công');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  it('returns an action-specific popup message for group member actions', async () => {
    mockGenerateText.mockImplementation(async (options: any) => {
      await options.tools.add_zalo_group_members.execute({ groupName: '' });
      return { text: '', usage: { totalTokens: 1 }, steps: [] };
    });
    const result = await ChatWorkflowAgentService.getInstance().runTurn({
      assistantId: 'assistant',
      messages: [{ role: 'user', content: 'Thêm thành viên cho tôi' }],
    });
    expect(JSON.parse(result.result)[0].content).toBe('Chọn tài khoản, nhóm và thành viên cần thêm trong popup.');
  });

  it('auto-inserts a customer clarification into the current chat without sending it', async () => {
    mockGenerateText.mockImplementation(async (options: any) => {
      const blocked = await options.tools.insert_zalo_chat_reply.execute({ message: 'Cần báo giá bao nhiêu chiếc?' });
      expect(blocked.status).toBe('needs_current_chat_read');
      await options.tools.read_current_zalo_chat.execute({ limit: 50 });
      const inserted = await options.tools.insert_zalo_chat_reply.execute({ message: 'Cần báo giá bao nhiêu chiếc?' });
      expect(inserted.status).toBe('inserted_into_chat');
      return { text: 'unused', usage: { totalTokens: 10 }, steps: [] };
    });
    const result = await ChatWorkflowAgentService.getInstance().runTurn({
      assistantId: 'assistant',
      messages: [{ role: 'user', content: 'Hỏi lại khách số lượng cần báo giá' }],
      triggerData: { zaloId: 'source', threadId: 'current-chat' },
    });
    expect(result.recipientRequest).toMatchObject({ type: 'insert_zalo_chat_reply', message: 'Cần báo giá bao nhiêu chiếc?' });
    expect(JSON.parse(result.result)[0].content).toBe('Cần báo giá bao nhiêu chiếc?');
  });

  it('documents minimal quote clarification instead of a detailed configuration survey', async () => {
    mockGenerateText.mockImplementation(async (options: any) => {
      const description = options.tools.insert_zalo_chat_reply.description;
      expect(description).toContain('thông tin tối thiểu');
      expect(description).toContain('Không tự hỏi CPU');
      expect(description).toContain('RAM');
      expect(description).toContain('SSD/HDD');
      expect(description).toContain('card đồ họa');
      return { text: 'Đã hiểu', usage: { totalTokens: 1 }, steps: [] };
    });
    await ChatWorkflowAgentService.getInstance().runTurn({
      assistantId: 'assistant',
      messages: [{ role: 'user', content: 'Hỏi giá sản phẩm đang rõ model' }],
      triggerData: { zaloId: 'source', threadId: 'current-chat' },
    });
  });

  it('requires reading the current Zalo chat and creates a neutral quote draft', async () => {
    mockGenerateText.mockImplementation(async (options: any) => {
      const blocked = await options.tools.prepare_quote_request.execute({
        productName: 'sản phẩm X', quantity: '100', unit: 'cái',
      });
      expect(blocked.status).toBe('needs_current_chat_read');
      await options.tools.read_current_zalo_chat.execute({ limit: 50 });
      const prepared = await options.tools.prepare_quote_request.execute({
        productName: 'sản phẩm X', quantity: '100', unit: 'cái',
      });
      expect(prepared.status).toBe('awaiting_user_selection');
      return { text: 'draft', usage: { totalTokens: 10 }, steps: [] };
    });
    const result = await ChatWorkflowAgentService.getInstance().runTurn({
      assistantId: 'assistant',
      messages: [{ role: 'user', content: 'Đọc chat hiện tại rồi chuẩn bị hỏi giá loại A' }],
      triggerData: { zaloId: 'source', threadId: 'current-chat' },
    });
    expect(result.recipientRequest).toMatchObject({ type: 'send_quote_to_configured_recipients' });
    expect(result.recipientRequest?.message).toContain('Có khách cần báo giá sản phẩm X, số lượng 100 cái.');
    expect(result.recipientRequest?.message).not.toContain('Địa điểm nhận hàng');
    expect(result.recipientRequest?.message).not.toContain('Thời gian cần hàng');
    expect(result.recipientRequest?.message).not.toContain('Hóa đơn');
    expect(result.recipientRequest?.message).not.toContain('Cảm ơn');
    expect(result.recipientRequest?.message).not.toContain('Anh/chị');
  });

  it('does not treat model text mentioning a tool as a popup request', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Bạn muốn gửi nội dung gì?', steps: [] });
    const result = await ChatWorkflowAgentService.getInstance().runTurn({
      assistantId: 'assistant', messages: [{ role: 'user', content: 'Xin chào' }],
    });
    expect(result.recipientRequest).toBeUndefined();
    expect(JSON.parse(result.result)[0].content).toBe('Bạn muốn gửi nội dung gì?');
  });

  it('can collect on a follow-up question without opening the sender popup again', async () => {
    mockGenerateText.mockImplementation(async (options: any) => {
      const result = await options.tools.get_zalo_replies.execute({});
      expect(result).toHaveProperty('error'); // No recorded tasks in this fixture DB.
      expect(options.stopWhen.some((stop: any) => stop({ steps: [] }))).toBe(false);
      return { text: 'Chưa có lượt gửi được theo dõi trong Chat này.', steps: [] };
    });
    const result = await ChatWorkflowAgentService.getInstance().runTurn({
      assistantId: 'assistant', messages: [{ role: 'user', content: 'Các nhóm đã báo giá chưa? Gom phản hồi giúp tôi.' }],
      triggerData: { zaloId: 'source', threadId: 'chat' },
    });
    expect(result.recipientRequest).toBeUndefined();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });
});
