/** UI requests produced by tools, never inferred from the model's response text. */
export type AIChatActionType =
  | 'select_zalo_recipients'
  | 'create_zalo_group'
  | 'add_zalo_group_members'
  | 'remove_zalo_group_members'
  | 'send_zalo_friend_requests'
  | 'insert_zalo_chat_reply'
  | 'send_quote_to_configured_recipients';

export interface AIChatRecipientRequest {
  id: string;
  type: AIChatActionType;
  message: string;
  /** Optional model-proposed value. The user can always edit/replace it in the popup. */
  groupName?: string;
}

export interface ZaloMessageTarget {
  threadId: string;
  threadType: number;
  accountId: string;
  displayName?: string;
}

export interface ZaloMessageSendResult extends ZaloMessageTarget {
  success: boolean;
  error?: string;
  taskId?: string;
  messageId?: string;
  trackingWarning?: string;
}
