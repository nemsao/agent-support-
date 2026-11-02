import React, { useEffect, useMemo, useState } from 'react';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import type { AIChatRecipientRequest } from '../../../models/aiChatTools';

type Person = { id: string; name: string; avatar?: string; phone?: string };
type Group = { id: string; name: string; avatar?: string; accountId: string };

function extractGroupInfo(response: any, groupId: string) {
  const map = response?.gridInfoMap || response?.changed_groups || {};
  return map[groupId] || Object.values(map)[0] || {};
}

function extractMemberIds(info: any): string[] {
  const ids = new Set<string>();
  for (const value of info?.memberIds || []) ids.add(String(value).replace(/_0$/, ''));
  for (const value of info?.memVerList || []) ids.add(String(value).replace(/_[0-9]+$/, ''));
  for (const member of info?.currentMems || []) {
    const id = member?.id || member?.userId;
    if (id) ids.add(String(id).replace(/_0$/, ''));
  }
  return [...ids].filter(Boolean);
}

export default function AIGroupActionModal({ request, onClose, onComplete }: {
  request: AIChatRecipientRequest;
  onClose: () => void;
  onComplete: (message: string) => void;
}) {
  const { accounts } = useAccountStore();
  const { showNotification } = useAppStore();
  const [accountId, setAccountId] = useState(request.type === 'select_zalo_recipients' ? '' : accounts[0]?.zalo_id || '');
  const [people, setPeople] = useState<Person[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set());
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [groupName, setGroupName] = useState(request.groupName || '');
  const [message, setMessage] = useState(request.message || 'Xin chào! Mình muốn kết bạn với bạn.');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const account = accounts.find(a => a.zalo_id === accountId);
  const auth = account ? buildZaloAuth(account, accountId) : null;
  const isCreate = request.type === 'create_zalo_group';
  const isAdd = request.type === 'add_zalo_group_members';
  const isRemove = request.type === 'remove_zalo_group_members';
  const isFriend = request.type === 'send_zalo_friend_requests';

  const selectedGroup = groups.find(g => g.id === selectedGroupId);
  const filteredPeople = useMemo(() => {
    const q = search.trim().toLowerCase();
    return people.filter(person => !q || `${person.name} ${person.phone || ''} ${person.id}`.toLowerCase().includes(q));
  }, [people, search]);

  useEffect(() => {
    if (!accountId || !auth) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const friendsRes = await ipc.zalo?.getFriends(auth);
        const friendList = Array.isArray(friendsRes?.response) ? friendsRes.response : [];
        const mapped: Person[] = friendList.map((item: any) => ({
          id: String(item.userId || item.uid || item.id || ''),
          name: item.alias || item.displayName || item.zaloName || item.userId || item.uid || 'Không tên',
          avatar: item.avatar,
          phone: item.phoneNumber,
        })).filter(item => item.id);
        if (!cancelled) setPeople(mapped);

        if (isCreate || isFriend) {
          if (!cancelled) setGroups([]);
        } else {
          const contactsRes = await ipc.db?.getContacts(accountId);
          const contactGroups = (contactsRes?.contacts || [])
            .filter((item: any) => item.contact_type === 'group' && item.contact_id)
            .map((item: any) => ({ id: String(item.contact_id), name: item.alias || item.display_name || item.contact_id, avatar: item.avatar_url, accountId }));
          const groupRes = await ipc.zalo?.getGroups(auth);
          const map = groupRes?.response?.gridInfoMap || {};
          const seen = new Set(contactGroups.map((item: Group) => item.id));
          for (const [id, info] of Object.entries(map)) {
            if (!seen.has(id)) contactGroups.push({ id, name: (info as any)?.name || `Nhóm ${id}`, avatar: (info as any)?.avatar || (info as any)?.avt, accountId });
          }
          if (!cancelled) setGroups(contactGroups);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Không thể tải dữ liệu Zalo');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accountId]);

  const searchUnknownUser = async () => {
    if (!auth || !search.trim() || isRemove) return;
    setLoading(true);
    setError('');
    try {
      const query = search.trim();
      const result = await ipc.zalo?.findUser({ auth, phone: query, username: query });
      const raw = result?.response?.info || result?.response?.data || result?.response;
      const candidate = Array.isArray(raw) ? raw[0] : raw;
      const id = String(candidate?.userId || candidate?.uid || candidate?.id || '');
      if (!id) {
        setError('Không tìm thấy người dùng. Hãy nhập số điện thoại hoặc UID Zalo chính xác.');
        return;
      }
      let profile: any = candidate;
      try {
        const infoResult = await ipc.zalo?.getUserInfo({ auth, userId: id });
        const map = infoResult?.response?.changed_profiles || infoResult?.response?.data || {};
        profile = map[id] || candidate;
      } catch {}
      const person: Person = {
        id,
        name: profile?.displayName || profile?.zaloName || candidate?.displayName || candidate?.zaloName || id,
        avatar: profile?.avatar || candidate?.avatar,
        phone: profile?.phoneNumber || query,
      };
      setPeople(prev => [person, ...prev.filter(item => item.id !== id)]);
      setSelectedPeople(prev => new Set(prev).add(id));
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Không thể tra cứu người dùng');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedGroupId || !auth || (!isAdd && !isRemove)) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const result = await ipc.zalo?.getGroupInfo({ auth, groupId: selectedGroupId });
        const info = extractGroupInfo(result?.response, selectedGroupId);
        const memberIds = extractMemberIds(info);
        if (isAdd) {
          if (!cancelled) setPeople(prev => prev.filter(person => !memberIds.includes(person.id)));
        } else {
          const current = (info?.currentMems || []).map((member: any) => ({
            id: String(member?.id || member?.userId || '').replace(/_0$/, ''),
            name: member?.dName || member?.displayName || member?.zaloName || String(member?.id || member?.userId || ''),
            avatar: member?.avatar,
          })).filter((person: Person) => person.id);
          const known = new Set(current.map(person => person.id));
          for (const id of memberIds) if (!known.has(id)) current.push({ id, name: id });
          if (!cancelled) setPeople(current);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Không thể tải thành viên nhóm');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedGroupId]);

  const title = isCreate ? 'Tạo nhóm Zalo' : isAdd ? 'Thêm thành viên vào nhóm' : isRemove ? 'Xóa thành viên khỏi nhóm' : isFriend ? 'Gửi lời mời kết bạn' : 'Mở chat mới';
  const actionLabel = isCreate ? 'Tạo nhóm' : isAdd ? 'Thêm thành viên' : isRemove ? 'Xóa thành viên' : isFriend ? 'Gửi lời mời' : 'Mở chat';
  const togglePerson = (id: string) => setSelectedPeople(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const handleSubmit = async () => {
    if (!auth || !accountId || working) return;
    if ((isCreate && (!groupName.trim() || selectedPeople.size === 0)) || ((isAdd || isRemove) && (!selectedGroupId || selectedPeople.size === 0)) || (isFriend && selectedPeople.size === 0)) return;
    setWorking(true);
    try {
      let success = 0;
      let failed = 0;
      if (isCreate) {
        const result = await ipc.zalo?.createGroup({ auth, name: groupName.trim(), members: [...selectedPeople] });
        if (result?.success) success++; else failed++;
      } else {
        for (const userId of selectedPeople) {
          try {
            const result = isAdd
              ? await ipc.zalo?.addUserToGroup({ auth, userId, groupId: selectedGroupId })
              : isRemove
                ? await ipc.zalo?.removeUserFromGroup({ auth, userId, groupId: selectedGroupId })
                : await ipc.zalo?.sendFriendRequest({ auth, userId, msg: message.trim() || 'Xin chào! Mình muốn kết bạn với bạn.' });
            if (result?.success) success++; else failed++;
          } catch { failed++; }
        }
      }
      const subject = isCreate ? groupName.trim() : selectedGroup?.name || '';
      const resultText = `${actionLabel}: ${success} thành công${failed ? `, ${failed} thất bại` : ''}${subject ? ` (${subject})` : ''}.`;
      if (success > 0) showNotification(resultText, 'success');
      if (failed > 0) showNotification(`${failed} thao tác thất bại`, 'error');
      onComplete(resultText);
    } catch (e: any) {
      const resultText = `${actionLabel} thất bại: ${e?.message || 'Lỗi không xác định'}`;
      showNotification(resultText, 'error');
      onComplete(resultText);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl w-[480px] max-h-[88vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
          <div><h2 className="text-white font-semibold text-base">{title}</h2><p className="text-xs text-gray-400 mt-0.5">Kiểm tra lựa chọn rồi xác nhận thao tác</p></div>
          <button onClick={onClose} disabled={working} className="w-8 h-8 rounded-full hover:bg-gray-700 text-gray-400 hover:text-white">×</button>
        </div>
        <div className="px-4 py-3 border-b border-gray-700">
          <label className="block text-xs text-gray-400 mb-1">Tài khoản thực hiện</label>
          <select value={accountId} onChange={e => { setAccountId(e.target.value); setSelectedPeople(new Set()); setSelectedGroupId(''); }} className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white">
            {accounts.filter(a => a.channel === 'zalo').map(accountItem => <option key={accountItem.zalo_id} value={accountItem.zalo_id}>{accountItem.full_name || accountItem.zalo_id}</option>)}
          </select>
        </div>
        {isCreate && <div className="px-4 py-3 border-b border-gray-700"><label className="block text-xs text-gray-400 mb-1">Tên nhóm</label><input value={groupName} onChange={e => setGroupName(e.target.value)} placeholder="Nhập tên nhóm" className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white" /></div>}
        {(isAdd || isRemove) && <div className="px-4 py-3 border-b border-gray-700"><label className="block text-xs text-gray-400 mb-1">Nhóm</label><select value={selectedGroupId} onChange={e => { setSelectedGroupId(e.target.value); setSelectedPeople(new Set()); }} className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white"><option value="">Chọn nhóm...</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></div>}
        {isFriend && <div className="px-4 py-3 border-b border-gray-700"><label className="block text-xs text-gray-400 mb-1">Lời nhắn kết bạn</label><textarea value={message} onChange={e => setMessage(e.target.value)} maxLength={200} rows={2} className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white resize-none" /></div>}
        <div className="px-4 py-2 border-b border-gray-700"><div className="flex gap-2"><input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && searchUnknownUser()} placeholder={isRemove ? 'Tìm thành viên...' : 'Tên, số điện thoại hoặc UID...'} className="flex-1 bg-gray-700 border border-gray-600 rounded-full px-3 py-2 text-sm text-white" />{!isRemove && <button onClick={searchUnknownUser} disabled={!search.trim() || loading} className="px-3 rounded-lg bg-gray-600 text-xs text-white hover:bg-gray-500 disabled:opacity-40">Tra cứu</button>}</div></div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? <p className="text-center text-gray-400 text-sm py-10">Đang tải dữ liệu...</p> : error ? <p className="text-center text-red-400 text-sm py-10 px-4">{error}</p> : filteredPeople.map(person => <button key={person.id} onClick={() => togglePerson(person.id)} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-700 text-left"><span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${selectedPeople.has(person.id) ? 'bg-blue-600 border-blue-600' : 'border-gray-500'}`}>{selectedPeople.has(person.id) && <span className="text-white text-xs">✓</span>}</span>{person.avatar ? <img src={person.avatar} className="w-9 h-9 rounded-full object-cover" /> : <span className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white">{person.name.charAt(0)}</span>}<span className="text-sm text-gray-200 truncate">{person.name}</span></button>)}
          {!loading && !error && filteredPeople.length === 0 && <p className="text-center text-gray-400 text-sm py-10">Không có dữ liệu phù hợp</p>}
        </div>
        <div className="px-5 py-2 border-t border-gray-700 text-xs text-gray-400">Đã chọn <span className="text-blue-400 font-semibold">{selectedPeople.size}</span> người</div>
        <div className="flex gap-3 px-5 py-4 border-t border-gray-700"><button onClick={onClose} disabled={working} className="flex-1 py-2.5 rounded-xl border border-gray-600 text-sm text-gray-300 hover:bg-gray-700">Hủy</button><button onClick={handleSubmit} disabled={working || !auth || (isCreate ? !groupName.trim() || selectedPeople.size === 0 : (isAdd || isRemove) ? !selectedGroupId || selectedPeople.size === 0 : selectedPeople.size === 0)} className={`flex-1 py-2.5 rounded-xl text-sm text-white font-medium disabled:opacity-40 ${isRemove ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}>{working ? 'Đang thực hiện...' : `${actionLabel}${selectedPeople.size ? ` (${selectedPeople.size})` : ''}`}</button></div>
      </div>
    </div>
  );
}
