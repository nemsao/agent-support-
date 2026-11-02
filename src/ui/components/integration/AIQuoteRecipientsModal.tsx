import React, { useEffect, useMemo, useState } from 'react';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';

type Recipient = { threadId: string; threadType: number; displayName: string; enabled: boolean };

export default function AIQuoteRecipientsModal({ assistantId, accountId, onClose }: {
  assistantId: string;
  accountId: string;
  onClose: () => void;
}) {
  const { accounts } = useAccountStore();
  const { showNotification } = useAppStore();
  const [items, setItems] = useState<Recipient[]>([]);
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const account = accounts.find(item => item.zalo_id === accountId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await ipc.ai?.getQuoteRecipients({ assistantId, accountId });
        const savedRows: Recipient[] = (saved?.recipients || []).map((row: any) => ({
          threadId: String(row.thread_id ?? row.threadId ?? ''),
          threadType: Number(row.thread_type ?? row.threadType ?? 1),
          displayName: String(row.display_name ?? row.displayName ?? row.thread_id ?? row.threadId ?? ''),
          enabled: row.enabled === 1 || row.enabled === true,
        })).filter((row: Recipient) => row.threadId);
        const savedKeys = new Set(savedRows.filter(row => row.enabled).map(row => `${row.threadType}:${row.threadId}`));
        if (!account) { if (!cancelled) setLoading(false); return; }
        const auth = buildZaloAuth(account, accountId);
        const contactsRes = await ipc.db?.getContacts(accountId);
        const rows: Recipient[] = (contactsRes?.contacts || [])
          .filter((item: any) => item.contact_id && (item.contact_type === 'group' || item.contact_type === 'user'))
          .map((item: any) => ({ threadId: String(item.contact_id), threadType: item.contact_type === 'group' ? 1 : 0, displayName: item.alias || item.display_name || item.contact_id, enabled: savedKeys.has(`${item.contact_type === 'group' ? 1 : 0}:${item.contact_id}`) }));
        try {
          const groupRes = await ipc.zalo?.getGroups(auth);
          const map = groupRes?.response?.gridInfoMap || {};
          const existing = new Set(rows.map(row => `${row.threadType}:${row.threadId}`));
          for (const [threadId, info] of Object.entries(map)) {
            const key = `1:${threadId}`;
            if (!existing.has(key)) rows.push({ threadId, threadType: 1, displayName: (info as any)?.name || `Nhóm ${threadId}`, enabled: savedKeys.has(key) });
          }
        } catch {}
        if (!cancelled) {
          const present = new Set(rows.map(row => `${row.threadType}:${row.threadId}`));
          for (const savedRow of savedRows) {
            const key = `${savedRow.threadType}:${savedRow.threadId}`;
            if (!present.has(key)) rows.push(savedRow);
          }
          setItems(rows);
          setConfigured(new Set(savedRows.filter(row => row.enabled).map(row => `${row.threadType}:${row.threadId}`)));
        }
      } catch (e: any) {
        if (!cancelled) showNotification(e?.message || 'Không thể tải danh sách nơi hỏi giá', 'error');
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [assistantId, accountId]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter(item => !query || item.displayName.toLowerCase().includes(query) || item.threadId.includes(query));
  }, [items, search]);

  const toggle = (item: Recipient) => setConfigured(previous => {
    const next = new Set(previous);
    const key = `${item.threadType}:${item.threadId}`;
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const save = async () => {
    setSaving(true);
    try {
      const result = await ipc.ai?.saveQuoteRecipients({
        assistantId,
        accountId,
        recipients: items.map(item => ({ ...item, enabled: configured.has(`${item.threadType}:${item.threadId}`) })),
      });
      if (!result?.success) throw new Error(result?.error || 'Không thể lưu');
      showNotification('Đã lưu danh sách nơi hỏi giá', 'success');
      onClose();
    } catch (e: any) { showNotification(e?.message || 'Không thể lưu danh sách nơi hỏi giá', 'error'); }
    finally { setSaving(false); }
  };

  return <div className="fixed inset-0 z-[240] flex items-center justify-center bg-black/70" onClick={onClose}>
    <div className="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl w-[430px] max-h-[80vh] flex flex-col overflow-hidden" onClick={event => event.stopPropagation()}>
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
        <div><h2 className="text-white font-semibold">Nơi hỏi giá mặc định</h2><p className="text-xs text-gray-400 mt-1">{account?.full_name || accountId}</p></div>
        <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">×</button>
      </div>
      <div className="px-4 py-3 border-b border-gray-700"><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Tìm nhóm hoặc user..." className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white" /></div>
      <div className="flex-1 overflow-y-auto">
        {loading ? <p className="text-center text-gray-400 py-10 text-sm">Đang tải...</p> : filtered.map(item => { const key = `${item.threadType}:${item.threadId}`; const active = configured.has(key); return <button key={key} onClick={() => toggle(item)} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-700 text-left"><span className={`w-5 h-5 rounded border flex items-center justify-center ${active ? 'bg-blue-600 border-blue-600' : 'border-gray-500'}`}>{active && <span className="text-white text-xs">✓</span>}</span><span className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-sm ${item.threadType === 1 ? 'bg-purple-600' : 'bg-blue-600'}`}>{item.displayName.charAt(0)}</span><span className="text-sm text-gray-200 truncate">{item.displayName}</span></button>; })}
        {!loading && filtered.length === 0 && <p className="text-center text-gray-400 py-10 text-sm">Không tìm thấy user/nhóm</p>}
      </div>
      <div className="px-5 py-2 border-t border-gray-700 text-xs text-gray-400">Đã chọn {configured.size} nơi hỏi giá</div>
      <div className="flex gap-3 px-5 py-4 border-t border-gray-700"><button onClick={onClose} disabled={saving} className="flex-1 py-2.5 rounded-xl border border-gray-600 text-sm text-gray-300">Hủy</button><button onClick={save} disabled={saving} className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-sm text-white disabled:opacity-40">{saving ? 'Đang lưu...' : 'Lưu cài đặt'}</button></div>
    </div>
  </div>;
}
