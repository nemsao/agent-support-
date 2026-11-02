import { useCallback } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import { buildZaloAuth } from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { syncZaloGroups, SyncGroupsProgress } from '@/lib/zaloGroupUtils';

interface UsePremiumMemberSyncOptions {
  accountId: string;
  groupId: string;
  onMembersSynced?: () => void;
}

interface UsePremiumMemberSyncResult {
  /** Always false — premium removed, all accounts use local sync */
  isPremium: boolean;
  /** Sync members: always local syncZaloGroups (cloud scan removed) */
  syncMembers: (opts?: {
    onProgress?: (p: SyncGroupsProgress) => void;
    stopRef?: React.MutableRefObject<boolean>;
  }) => Promise<void>;
}

/**
 * Hook for syncing group members.
 * Local-only build: cloud scan (deplaoapp.com) removed — every account
 * uses the normal local syncZaloGroups path.
 */
export function usePremiumMemberSync({
  accountId,
  groupId,
  onMembersSynced,
}: UsePremiumMemberSyncOptions): UsePremiumMemberSyncResult {
  const isPremium = false;

  const syncMembers = useCallback(async (opts?: {
    onProgress?: (p: SyncGroupsProgress) => void;
    stopRef?: React.MutableRefObject<boolean>;
  }) => {
    if (!accountId || !groupId) return;

    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) return;

    const auth = buildZaloAuth(acc, accountId);
    await syncZaloGroups({
      activeAccountId: accountId,
      auth,
      groupId,
      onProgress: opts?.onProgress,
      onPhase1Done: async () => {},
      onGroupEnriched: async () => {
        onMembersSynced?.();
      },
      stopRef: opts?.stopRef,
    });
  }, [accountId, groupId, onMembersSynced]);

  return { isPremium, syncMembers };
}
