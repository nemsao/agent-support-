/** Keep background quote updates conversational even if the model returns a report object. */
export function quoteReplyText(raw: string, snapshot: any): string {
  const unwrap = (value: any, depth = 0): string => {
    if (depth > 4 || value == null) return '';
    if (typeof value === 'string') {
      const text = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      try { return unwrap(JSON.parse(text), depth + 1); } catch {}
      return text.startsWith('{') || text.startsWith('[') ? '' : text;
    }
    if (Array.isArray(value)) return value.map(item => unwrap(item, depth + 1)).filter(Boolean).join('\n');
    if (typeof value !== 'object') return '';
    if (Array.isArray(value.summary)) {
      const lines = value.summary.map((row: any) => {
        const name = typeof row.recipientName === 'string' ? row.recipientName : '';
        const price = typeof row.quotedPrice === 'string' ? row.quotedPrice : '';
        const readablePrice = price.replace(/\b(\d+(?:[.,]\d+)?)\s*tr\b/gi, '$1 triệu đồng');
        return name && price ? `${name} vừa phản hồi giá ${readablePrice}.` : '';
      }).filter(Boolean);
      return lines.join('\n');
    }
    if (value.type === 'text' && typeof value.content === 'string') return unwrap(value.content, depth + 1);
    for (const key of ['text', 'content', 'message']) {
      if (typeof value[key] === 'string') return unwrap(value[key], depth + 1);
    }
    return '';
  };

  const text = unwrap(raw);
  if (text) return text;
  const recipients: any[] = snapshot?.recipients || [];
  const lines = recipients.map(recipient => {
    const candidates = (recipient.messages || []).filter((message: any) => message.replyCandidate);
    const latest = candidates[candidates.length - 1];
    return latest ? `${recipient.name} vừa phản hồi: “${String(latest.content).slice(0, 300)}”.` : '';
  }).filter(Boolean);
  return lines.join('\n') || 'Đã nhận phản hồi mới cho yêu cầu báo giá.';
}
