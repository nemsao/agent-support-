import type { ZaloMessageSendResult, ZaloMessageTarget } from '../models/aiChatTools';

interface SenderAccount {
  zalo_id: string;
  channel?: string;
  cookies?: string;
  imei?: string;
  user_agent?: string;
}

/** Execute only the popup's explicit selection, using the existing Zalo IPC. */
export async function sendSelectedZaloMessages(
  message: string,
  targets: ZaloMessageTarget[],
  accounts: SenderAccount[],
  sendMessage: (params: any) => Promise<{ success?: boolean; error?: string; response?: any; trackingWarning?: string } | undefined>,
  taskId?: string,
): Promise<ZaloMessageSendResult[]> {
  const text = message.trim();
  if (!text) throw new Error('Vui lòng nhập nội dung tin nhắn.');
  if (text.length > 10000) throw new Error('Nội dung không được vượt quá 10.000 ký tự.');
  if (!targets.length) throw new Error('Vui lòng chọn ít nhất một user/nhóm.');

  const results: ZaloMessageSendResult[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const key = JSON.stringify([target.accountId, target.threadType, target.threadId]);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!target.threadId?.trim() || ![0, 1].includes(target.threadType)) {
        throw new Error('Người nhận không hợp lệ.');
      }
      const account = accounts.find(a => a.zalo_id === target.accountId);
      if (!account || (account.channel || 'zalo') !== 'zalo') {
        throw new Error('Không tìm thấy tài khoản Zalo gửi đã chọn.');
      }
      const response = await sendMessage({
        auth: {
          accountId: account.zalo_id,
          cookies: account.cookies || '',
          imei: account.imei || '',
          userAgent: account.user_agent || '',
        },
        strictAccountId: true,
        zaloId: account.zalo_id,
        ...(taskId ? { aiChatRequestId: taskId, aiChatDisplayName: target.displayName || '' } : {}),
        threadId: target.threadId,
        type: target.threadType,
        message: text,
      });
      if (!response?.success) throw new Error(response?.error || 'Không gửi được tin nhắn Zalo.');
      const messageId = response.response?.message?.msgId;
      const trackingWarning = response.trackingWarning || (taskId && messageId == null
        ? 'API đã nhận yêu cầu gửi nhưng chưa trả message ID để xác minh mốc phản hồi.'
        : undefined);
      results.push({ ...target, success: true, taskId, messageId: messageId == null ? undefined : String(messageId), trackingWarning });
    } catch (error: any) {
      results.push({ ...target, success: false, error: error.message || 'Không gửi được tin nhắn Zalo.' });
    }
  }
  return results;
}

export function summarizeZaloSendResults(results: ZaloMessageSendResult[]): string {
  const sent = results.filter(r => r.success).length;
  return [
    `Kết quả gửi Zalo: ${sent}/${results.length} thành công${sent < results.length ? `, ${results.length - sent} thất bại` : ''}.`,
    ...results.map(r => `${r.success ? '✓' : '✗'} ${r.threadType === 1 ? 'Nhóm' : 'User'} ${r.displayName || r.threadId}${r.success ? (r.messageId ? `: API đã gửi, mã tin ${r.messageId}` : ': API đã nhận yêu cầu gửi') : `: ${r.error}`}${r.trackingWarning ? ` (${r.trackingWarning})` : ''}`),
  ].join('\n');
}
