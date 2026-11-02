import React, { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { BotIcon, CheckIcon, EyeIcon, EyeOffIcon, RefreshIcon } from '../common/icons';

export default function GlobalAISettings() {
  const { showNotification } = useAppStore();
  const [endpoint, setEndpoint] = useState('https://api.xkiro.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('qwen/qwen3.8-omni-flash:free');
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    let mounted = true;
    ipc.ai?.getGlobalConfig().then((res: any) => {
      if (!mounted || !res?.success || !res.config) return;
      setEndpoint(res.config.endpoint || 'https://api.xkiro.com/v1');
      setApiKey(res.config.apiKey || '');
      setModel(res.config.model || 'qwen/qwen3.8-omni-flash:free');
    }).catch(() => {}).finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, []);

  const payload = () => ({ endpoint: endpoint.trim(), apiKey: apiKey.trim(), model: model.trim() });

  const handleSave = async () => {
    if (!endpoint.trim()) { showNotification('Vui lòng nhập endpoint AI', 'error'); return; }
    if (!model.trim()) { showNotification('Vui lòng nhập model AI', 'error'); return; }
    if (!apiKey.trim()) { showNotification('Vui lòng nhập API key', 'error'); return; }
    setSaving(true);
    try {
      const res = await ipc.ai?.saveGlobalConfig(payload());
      if (res?.success) showNotification('✅ Đã lưu cấu hình AI dùng chung', 'success');
      else showNotification('❌ ' + (res?.error || 'Lưu cấu hình thất bại'), 'error');
    } catch (e: any) {
      showNotification('❌ ' + e.message, 'error');
    } finally { setSaving(false); }
  };

  const handleTest = async () => {
    if (!endpoint.trim() || !model.trim() || !apiKey.trim()) {
      showNotification('Nhập endpoint, API key và model trước khi kiểm tra', 'warning');
      return;
    }
    setTesting(true);
    setStatus(null);
    try {
      const res = await ipc.ai?.testGlobalConfig(payload());
      setStatus({ success: !!res?.success, message: res?.message || res?.error || 'Không có phản hồi' });
    } catch (e: any) {
      setStatus({ success: false, message: e.message });
    } finally { setTesting(false); }
  };

  return (
    <>
      <h2 className="text-base font-semibold text-white flex items-center gap-2"><BotIcon className="w-4 h-4" /> AI dùng chung</h2>
      <Section>
        {loading ? <p className="text-sm text-gray-400">Đang tải cấu hình AI...</p> : (
          <div className="space-y-4">
            <div>
              <p className="text-sm text-gray-200 font-medium">Kết nối AI mặc định cho toàn bộ ứng dụng</p>
              <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                Nhập endpoint tương thích OpenAI để ChatGPT, Xkiro hoặc gateway khác được dùng chung cho chat, gợi ý trả lời và Workflow Agent.
                Assistant có cấu hình riêng sẽ được ưu tiên.
              </p>
            </div>

            <Field label="Endpoint API">
              <input value={endpoint} onChange={e => setEndpoint(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
               <p className="text-[10px] text-gray-500 mt-1">Có thể nhập dạng base URL hoặc đầy đủ /chat/completions. Xkiro mặc định: https://api.xkiro.com/v1</p>
            </Field>

            <Field label="API key">
              <div className="relative">
                <input type={showKey ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)}
                  placeholder="sk-..." autoComplete="off"
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 pr-10 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
                <button type="button" onClick={() => setShowKey(v => !v)} className="absolute right-2 top-2 text-gray-400 hover:text-white">
                  {showKey ? <EyeOffIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[10px] text-gray-500 mt-1">API key được mã hóa khi lưu và không hiển thị đầy đủ trong giao diện.</p>
            </Field>

            <Field label="Model mặc định">
              <input value={model} onChange={e => setModel(e.target.value)}
                 placeholder="qwen/qwen3.8-omni-flash:free"
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
            </Field>

            {status && (
              <div className={`rounded-lg px-3 py-2 text-xs border ${status.success ? 'text-green-300 bg-green-900/20 border-green-700/40' : 'text-red-300 bg-red-900/20 border-red-700/40'}`}>
                {status.message}
              </div>
            )}

            <div className="flex gap-2">
              <button onClick={handleSave} disabled={saving || testing}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg disabled:opacity-50">
                {saving ? <><RefreshIcon className="w-4 h-4 inline animate-spin" /> Đang lưu...</> : <><CheckIcon className="w-4 h-4 inline" /> Lưu cấu hình</>}
              </button>
              <button onClick={handleTest} disabled={saving || testing}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded-lg border border-gray-600 disabled:opacity-50">
                {testing ? <><RefreshIcon className="w-4 h-4 inline animate-spin" /> Đang kiểm tra...</> : 'Kiểm tra kết nối'}
              </button>
            </div>
          </div>
        )}
      </Section>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="block text-xs text-gray-400 mb-1">{label}</label>{children}</div>;
}

function Section({ children }: { children: React.ReactNode }) {
  return <div className="bg-gray-800 rounded-xl p-4">{children}</div>;
}
