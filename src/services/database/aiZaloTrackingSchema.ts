export const AI_ZALO_TRACKING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_zalo_tasks (
    id TEXT PRIMARY KEY,
    assistant_id TEXT NOT NULL,
    source_account_id TEXT NOT NULL,
    source_thread_id TEXT NOT NULL,
    task_type TEXT NOT NULL DEFAULT 'message',
    instruction TEXT NOT NULL,
    draft TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_zalo_tasks_source
    ON ai_zalo_tasks(assistant_id, source_account_id, source_thread_id, created_at);
  CREATE TABLE IF NOT EXISTS ai_zalo_deliveries (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES ai_zalo_tasks(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    thread_type INTEGER NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL,
    message_id TEXT,
    baseline_row_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    sent_at INTEGER,
    status TEXT NOT NULL,
    error TEXT,
    UNIQUE(task_id, account_id, thread_id, thread_type)
  );
  CREATE INDEX IF NOT EXISTS idx_ai_zalo_deliveries_task ON ai_zalo_deliveries(task_id);
  CREATE INDEX IF NOT EXISTS idx_ai_zalo_deliveries_thread ON ai_zalo_deliveries(account_id, thread_id);
  CREATE TABLE IF NOT EXISTS ai_zalo_quote_replies (
    id TEXT PRIMARY KEY,
    assistant_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES ai_zalo_tasks(id) ON DELETE CASCADE,
    delivery_id TEXT NOT NULL REFERENCES ai_zalo_deliveries(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    thread_type INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    message_timestamp INTEGER NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    processed_at INTEGER,
    UNIQUE(delivery_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ai_zalo_quote_replies_pending
    ON ai_zalo_quote_replies(assistant_id, account_id, thread_id, status, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_zalo_quote_replies_message
    ON ai_zalo_quote_replies(account_id, thread_id, thread_type, message_id);
`;
