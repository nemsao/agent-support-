import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { AIChatRecipientRequest } from '../../models/aiChatTools';

/** Stage a client-side tool. No message is sent until the popup is submitted. */
export function createChatZaloTools(
  tool: (definition: any) => any,
  onPrepare?: (request: AIChatRecipientRequest) => void,
  options?: { requireCurrentChatRead?: boolean },
) {
  let request: AIChatRecipientRequest | undefined;
  let currentChatRead = false;
  const prepare = (type: AIChatRecipientRequest['type'], message: string, groupName?: string) => {
    // At most one popup per turn, including parallel/repeated tool calls.
    if (!request) {
      const next: AIChatRecipientRequest = { id: randomUUID(), type, message: message.trim(), ...(groupName ? { groupName: groupName.trim() } : {}) };
      onPrepare?.(next);
      request = next;
    }
    return {
      status: type === 'insert_zalo_chat_reply' ? 'inserted_into_chat' : 'awaiting_user_selection',
      requestId: request.id,
      message: type === 'insert_zalo_chat_reply'
        ? 'Đã tự động chèn nội dung vào ô chat hiện tại. Chưa gửi tin.'
        : 'Chưa gửi tin. Popup sẽ mở để người dùng chọn user/nhóm, sửa nội dung và bấm Chạy.',
    };
  };

  return {
    getRequest: () => request,
    markCurrentChatRead: () => { currentChatRead = true; },
    tools: {
      select_zalo_recipients: tool({
        description: 'Mở popup có sẵn để người dùng chọn tài khoản gửi và nhiều user/nhóm Zalo. Có thể kèm nội dung soạn sẵn; người dùng sửa nội dung và bấm Chạy để gửi. Không tự chọn ID người nhận.',
        inputSchema: z.object({ message: z.string().max(10000).default('') }),
        execute: async ({ message }: { message: string }) => prepare('select_zalo_recipients', message),
      }),
      send_zalo_messages: tool({
        description: 'Chuẩn bị gửi nội dung từ chat đến user/nhóm Zalo do người dùng chọn qua popup. Luôn mở popup để xem/sửa tin, chọn người nhận và bấm Chạy; tool chưa gửi ngay. Không cần workflow.',
        inputSchema: z.object({ message: z.string().trim().min(1).max(10000) }),
        execute: async ({ message }: { message: string }) => prepare('select_zalo_recipients', message),
      }),
      prepare_quote_request: tool({
        description: 'Chuẩn bị nội dung hỏi giá mới dựa trên sản phẩm/model và số lượng đã được Agent xác định từ yêu cầu hiện tại và hội thoại Zalo. Luôn tạo draft mới, không dùng lại draft hỏi giá cũ. Tool chỉ mở popup chọn người nhận, chưa gửi tin.',
        inputSchema: z.object({
          productName: z.string().trim().min(1).max(500),
          quantity: z.string().trim().min(1).max(100),
          unit: z.string().trim().max(50).optional(),
        }),
        execute: async (input: {
          productName: string; quantity: string; unit?: string;
        }) => {
          if (options?.requireCurrentChatRead && !currentChatRead) {
            return {
              status: 'needs_current_chat_read',
              message: 'Phải đọc hội thoại Zalo hiện tại trước khi chuẩn bị hỏi giá. Hãy gọi read_current_zalo_chat rồi đánh giá lại sản phẩm, loại và số lượng.',
            };
          }
          const product = input.productName.trim();
          const quantity = `, số lượng ${input.quantity.trim()}${input.unit?.trim() ? ` ${input.unit.trim()}` : ''}`;
          const message = [
            `Có khách cần báo giá ${product}${quantity}.`,
            '',
            'Báo giúp giá.',
          ].join('\n');
          return prepare('send_quote_to_configured_recipients', message);
        },
      }),
      insert_zalo_chat_reply: tool({
        description: 'Tự động chèn một câu trả lời/câu hỏi ngắn vào ô nhập tin của hội thoại Zalo hiện tại để CSKH kiểm tra và tự bấm gửi. Không gửi tin và không mở popup. Khi hỏi lại để báo giá, chỉ hỏi thông tin tối thiểu còn thiếu: tên/model sản phẩm, số lượng, hoặc loại/biến thể nếu thật sự chưa rõ. Không tự hỏi CPU, RAM, SSD/HDD, card đồ họa hay phụ kiện nếu khách chưa đề cập hoặc không có nhiều biến thể gây nhầm lẫn.',
        inputSchema: z.object({ message: z.string().trim().min(1).max(10000) }),
        execute: async ({ message }: { message: string }) => {
          if (options?.requireCurrentChatRead && !currentChatRead) {
            return {
              status: 'needs_current_chat_read',
              message: 'Phải đọc hội thoại Zalo hiện tại trước khi chèn câu trả lời vào ô chat. Hãy gọi read_current_zalo_chat trước.',
            };
          }
          return prepare('insert_zalo_chat_reply', message);
        },
      }),
      create_zalo_group: tool({
        description: 'Mở popup để người dùng chọn tài khoản và thành viên, chỉnh tên/ảnh nhóm rồi xác nhận tạo nhóm Zalo. Không tự tạo nhóm ngay và không tự chọn thành viên theo ID.',
        inputSchema: z.object({ name: z.string().max(200).default('') }),
        execute: async ({ name }: { name: string }) => prepare('create_zalo_group', name ? `Tên nhóm đề xuất: ${name}` : '' , name),
      }),
      add_zalo_group_members: tool({
        description: 'Mở popup để người dùng chọn nhóm và nhiều thành viên cần thêm. Không tự thao tác ngay, không tự suy đoán groupId hoặc userId.',
        inputSchema: z.object({ groupName: z.string().max(200).default('') }),
        execute: async ({ groupName }: { groupName: string }) => prepare('add_zalo_group_members', groupName ? `Nhóm đề xuất: ${groupName}` : '', groupName),
      }),
      remove_zalo_group_members: tool({
        description: 'Mở popup để người dùng chọn nhóm và thành viên cần xóa, sau đó xác nhận trong popup. Đây là thao tác có tính phá hủy; không tự xóa ngay và không tự suy đoán ID.',
        inputSchema: z.object({ groupName: z.string().max(200).default('') }),
        execute: async ({ groupName }: { groupName: string }) => prepare('remove_zalo_group_members', groupName ? `Nhóm đề xuất: ${groupName}` : '', groupName),
      }),
      send_zalo_friend_requests: tool({
        description: 'Mở popup để người dùng chọn một hoặc nhiều bạn bè và soạn lời nhắn kết bạn, rồi bấm xác nhận. Không tự gửi lời mời ngay.',
        inputSchema: z.object({ message: z.string().max(200).default('Xin chào! Mình muốn kết bạn với bạn.') }),
        execute: async ({ message }: { message: string }) => prepare('send_zalo_friend_requests', message),
      }),
    },
  };
}
