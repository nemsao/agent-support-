import React from 'react';

// Match only amounts with an explicit currency/scale. Product codes and
// quantities such as "CRS309" or "6 chiếc" keep their normal text styling.
const MONEY_PATTERN = /(?<![\p{L}\p{N}_])(?:[$€£¥]\s*\d[\d.,]*(?:[ \u00a0]\d{3})*|(?:USD|EUR|GBP|JPY|CNY|VND|VNĐ)\s*\d[\d.,]*(?:[ \u00a0]\d{3})*|\d[\d.,]*(?:[ \u00a0]\d{3})*\s*(?:(?:tỷ|tỉ|triệu|nghìn|ngàn)\s*(?:đồng|VNĐ|VND|USD|EUR|đ|₫)?|đồng|VNĐ|VND|USD|EUR|GBP|JPY|CNY|tr|k|đ|₫|[$€£¥]))(?=$|[\s.,;:!?\)\]”"/])/giu;

export function hasQuoteAmount(text: string): boolean {
  return new RegExp(MONEY_PATTERN.source, MONEY_PATTERN.flags).test(text);
}

export default function AIQuoteReplyCard({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let previousEnd = 0;
  for (const match of text.matchAll(new RegExp(MONEY_PATTERN.source, MONEY_PATTERN.flags))) {
    const start = match.index!;
    if (start > previousEnd) parts.push(text.slice(previousEnd, start));
    parts.push(
      <mark key={start} className="inline-block align-baseline my-1 rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[21px] font-bold leading-snug tracking-tight text-emerald-300 tabular-nums break-words">
        {match[0]}
      </mark>,
    );
    previousEnd = start + match[0].length;
  }
  if (previousEnd < text.length) parts.push(text.slice(previousEnd));

  return (
    <div className="relative overflow-hidden rounded-t-xl bg-gradient-to-br from-emerald-950/70 via-slate-900 to-slate-900 px-3.5 pb-3 pt-3">
      <div aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-gradient-to-b from-emerald-300 to-teal-600" />
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-emerald-400/20 bg-emerald-400/10 text-emerald-300" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 13 13 20a2 2 0 0 1-2.8 0L3 12.8V3h9.8l7.2 7.2a2 2 0 0 1 0 2.8Z" />
            <circle cx="7.5" cy="7.5" r="1" />
          </svg>
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-300">Cập nhật báo giá</span>
      </div>
      <div className="whitespace-pre-wrap break-words text-[13px] leading-7 text-slate-200">{parts}</div>
    </div>
  );
}
