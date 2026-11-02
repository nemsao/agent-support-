/**
 * WorkflowAgentService.ts
 *
 * Interactive AI agent for building & editing workflows.
 * Uses Vercel AI SDK generateText + tool calling (no single-shot prompt
 * stuffing): the model decides WHICH tools to call per intent —
 *   - create from scratch → only list_node_catalog
 *   - edit existing      → get_current_workflow / get_node_config
 * The apply_operations tool runs the validator IN the loop, so schema/id/
 * cycle errors flow back to the model for in-loop self-correction.
 *
 * Final result is either { ops } (validated) or { question } (Cách A —
 * ask the user, continue next turn).
 *
 * Main process only. AI SDK (ESM-only) loaded via dynamic import.
 */

import { z } from 'zod';
import Logger from '../../utils/Logger';
import { createSdkModel } from './AiSdkProviderFactory';
import {
  buildNodeCatalog,
  validateWorkflowOps,
  type WfNode,
  type WfEdge,
  type WorkflowOps,
  type ValidationResult,
} from './workflowAIValidator';

// ── Types ───────────────────────────────────────────────────────────────────

export interface AgentTurnRequest {
  assistantId: string;
  /** LLM provider config resolved by the caller (aiAssistantIpc) */
  platform: string;
  model: string;
  apiKey: string;
  baseUrl: string | null;
  /** Current canvas state */
  currentNodes: WfNode[];
  currentEdges: WfEdge[];
  channel: string;
  /** User prompt for this turn */
  userPrompt: string;
  /** Multi-turn history from the dialog: [{role: 'user'|'assistant', content}] */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface AgentStepEvent {
  type: 'tool-call' | 'tool-result' | 'thinking' | 'final';
  message: string;
  ts: number;
}

export interface AgentTurnResult {
  success: boolean;
  /** Validated operations to apply (present when the agent finished with ops) */
  ops?: WorkflowOps;
  /** Question for the user — Cách A (agent could not decide) */
  question?: string;
  /** Human-readable summary of what was done */
  summary?: string;
  /** Full step log for the UI */
  steps: AgentStepEvent[];
  validation?: ValidationResult;
  error?: string;
}

const MAX_STEPS = 8;

// ── System prompt (deliberately LEAN — the agent fetches context via tools) ─

function buildSystemPrompt(channel: string): string {
  return `Bạn là AI Agent chuyên xây dựng & chỉnh sửa Workflow cho phần mềm Deplao (kênh: ${channel}).

QUY TRÌNH BẮT BUỘC (KHÔNG ĐƯỢC BỎ BƯỚC NÀO):
1. TẠO MỚI workflow (canvas trống / user muốn thêm độc lập): gọi list_node_catalog để biết node khả dụng, NGAY SAU ĐÓ gọi apply_operations với add.
2. SỬA/XÓA/NỐI node hiện có: gọi get_current_workflow (hoặc get_node_config khi user chỉ rõ node) để đọc cấu trúc, NGAY SAU KHI đọc kết quả tool BẮT BUỘC gọi apply_operations với update/delete/rewire/deleteEdges.
3. apply_operations trả lỗi → đọc lỗi, tự sửa ops, gọi lại (tối đa vài lần).
4. Kết thúc lượt bằng summary ngắn gọn tiếng Việt.

TUYỆT ĐỐI KHÔNG: kết thúc lượt sau khi chỉ gọi tool đọc dữ liệu (list_node_catalog / get_current_workflow / get_node_config) mà chưa gọi apply_operations.

CHỈ được kết thúc lượt KHÔNG apply khi yêu cầu MƠ HỒ không xác định được node (VD "sửa node gửi tin" nhưng có nhiều node giống nhau) — khi đó hỏi user 1 câu ngắn.

QUY TẮC APPLY_OPERATIONS:
1. update.config PHẢI là FULL config của node (copy nguyên config từ get_current_workflow/get_node_config rồi sửa field cần đổi) — KHÔNG gửi từng field lẻ.
2. nodeId trong update/delete/rewire/deleteEdges PHẢI là id node HIỆN CÓ trên canvas.
3. id node mới trong add: node_1, node_2... mỗi id duy nhất.
4. sourceHandle: "default" (hoặc "true"/"false" cho node logic.if).
5. KHÔNG tạo cycle (edge nối ngược node phía trước).
6. Biến template: {{ $trigger.content }}, {{ $trigger.threadId }}, {{ $trigger.fromId }}, {{ $trigger.fromName }}, {{ $prev.result }}, {{ $vars.<tên> }}.`;
}

// ── Service ─────────────────────────────────────────────────────────────────

class WorkflowAgentService {
  private static instance: WorkflowAgentService;

  public static getInstance(): WorkflowAgentService {
    if (!WorkflowAgentService.instance) WorkflowAgentService.instance = new WorkflowAgentService();
    return WorkflowAgentService.instance;
  }

  private constructor() {}

  public async runTurn(req: AgentTurnRequest, onStep?: (e: AgentStepEvent) => void): Promise<AgentTurnResult> {
    const steps: AgentStepEvent[] = [];
    const emit = (type: AgentStepEvent['type'], message: string) => {
      const e = { type, message, ts: Date.now() };
      steps.push(e);
      try { onStep?.(e); } catch {}
    };

    try {
      // Dynamic import — ESM-only packages from the CJS main process
      const [{ generateText, stepCountIs, tool }, { createOpenAICompatible }] = await Promise.all([
        import('ai'),
        import('@ai-sdk/openai-compatible'),
      ]);

      const handle = createSdkModel(createOpenAICompatible, req.platform, req.model, req.apiKey, req.baseUrl);
      emit('thinking', `Kết nối model ${req.model} (${req.platform})…`);

      // Compact current workflow for tool results (drop positions)
      const compactNodes = req.currentNodes.map(n => ({
        id: n.id, type: n.type, label: n.label || '', config: n.config || {},
      }));

      // ── Tool: list_node_catalog ────────────────────────────────────────
      const listCatalog = tool({
        description: 'Lấy danh mục tất cả node khả dụng cho kênh hiện tại (type, label, mô tả, config keys). Dùng khi tạo workflow mới hoặc cần biết có node loại gì.',
        inputSchema: z.object({}),
        execute: async () => {
          emit('tool-call', 'Đang đọc danh mục node…');
          const catalog = buildNodeCatalog(req.channel);
          emit('tool-result', `Danh mục node: ${catalog.split('\n').length} dòng`);
          return { channel: req.channel, catalog };
        },
      });

      // ── Tool: get_current_workflow ─────────────────────────────────────
      const getCurrentWorkflow = tool({
        description: 'Lấy cấu trúc workflow HIỆN TẠI trên canvas (nodes + edges + config đầy đủ). Dùng khi user muốn SỬA/XÓA/NỐI lại node hiện có.',
        inputSchema: z.object({}),
        execute: async () => {
          emit('tool-call', 'Đang đọc workflow hiện tại…');
          emit('tool-result', `Workflow hiện tại: ${compactNodes.length} node, ${req.currentEdges.length} liên kết`);
          return {
            nodes: compactNodes,
            edges: req.currentEdges.map(e => ({ source: e.source, sourceHandle: e.sourceHandle || 'default', target: e.target })),
          };
        },
      });

      // ── Tool: get_node_config ──────────────────────────────────────────
      const getNodeConfig = tool({
        description: 'Lấy config đầy đủ của MỘT node hiện có theo id. Nhẹ hơn get_current_workflow khi user chỉ rõ node cần sửa.',
        inputSchema: z.object({ nodeId: z.string().describe('id node hiện có trên canvas') }),
        execute: async ({ nodeId }) => {
          emit('tool-call', `Đang đọc config node ${nodeId}…`);
          const node = req.currentNodes.find(n => String(n.id) === String(nodeId));
          if (!node) {
            emit('tool-result', `Không tìm thấy node ${nodeId}`);
            return { error: `Node "${nodeId}" không tồn tại. Gọi get_current_workflow để xem các id hiện có.` };
          }
          emit('tool-result', `Đã đọc config node ${node.label || nodeId}`);
          return { id: node.id, type: node.type, label: node.label || '', config: node.config || {} };
        },
      });

      // ── Tool: apply_operations (validator runs INSIDE the loop) ────────
      const applyOperations = tool({
        description: 'Đề xuất và kiểm tra các thao tác lên workflow. Thao tác chỉ được ghi nhận khi hợp lệ; nếu có lỗi, đọc lỗi và gọi lại với ops đã sửa.',
        inputSchema: z.object({
          add: z.object({
            nodes: z.array(z.object({
              id: z.string(),
              type: z.string(),
              label: z.string().optional(),
              config: z.record(z.string(), z.any()).optional(),
            })),
            edges: z.array(z.object({
              source: z.string(),
              sourceHandle: z.string().optional(),
              target: z.string(),
            })),
          }).optional(),
          update: z.array(z.object({
            nodeId: z.string(),
            label: z.string().optional(),
            config: z.record(z.string(), z.any()).optional(),
          })).optional(),
          delete: z.object({ nodeIds: z.array(z.string()) }).optional(),
          rewire: z.object({
            edges: z.array(z.object({
              source: z.string(),
              sourceHandle: z.string().optional(),
              target: z.string(),
            })),
          }).optional(),
          deleteEdges: z.array(z.object({
            source: z.string(),
            target: z.string(),
          })).optional(),
        }),
        execute: async (ops) => {
          emit('tool-call', 'Đang soạn & kiểm tra thao tác…');
          const result = validateWorkflowOps(ops, req.currentNodes, req.currentEdges, req.channel);
          if (result.valid) {
            const parts: string[] = [];
            if (result.ops?.add) parts.push(`+${result.ops.add.nodes.length} node`);
            if (result.ops?.update) parts.push(`~${result.ops.update.length} sửa`);
            if (result.ops?.delete) parts.push(`×${result.ops.delete.nodeIds.length} xóa`);
            if (result.ops?.rewire) parts.push(`→${result.ops.rewire.edges.length} nối`);
            if (result.ops?.deleteEdges) parts.push(`✂${result.ops.deleteEdges.length} ngắt`);
            emit('tool-result', `✔ Hợp lệ: ${parts.join(', ') || '(không đổi)'}`);
            return {
              ok: true,
              applied: parts.join(', ') || 'no-op',
              warnings: result.warnings,
              ops: result.ops,
            };
          }
          emit('tool-result', `✘ ${result.errors.length} lỗi — agent tự sửa`);
          return {
            ok: false,
            errors: result.errors,
            warnings: result.warnings,
            hint: 'Sửa ops theo từng lỗi ở trên rồi gọi apply_operations lại. nodeId phải là id node HIỆN CÓ (xem get_current_workflow).',
          };
        },
      });

      // ── Run the agent loop (under the concurrency limiter — Boss-shared
      //    local LLMs get max 2 concurrent requests, the rest queue) ─────
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
        ...req.history.slice(-8).map(h => ({ role: h.role, content: h.content })),
        { role: 'user' as const, content: req.userPrompt },
      ];

      const { withAiLimit } = require('./AiConcurrencyLimiter');
      const result = await withAiLimit(req.platform, () => generateText({
        model: handle.model,
        system: buildSystemPrompt(req.channel),
        messages,
        tools: { list_node_catalog: listCatalog, get_current_workflow: getCurrentWorkflow, get_node_config: getNodeConfig, apply_operations: applyOperations },
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal: AbortSignal.timeout(handle.maxDuration * MAX_STEPS),
      }));

      // ── Extract the LAST successful apply_operations result ───────────
      // AI SDK step shape: { toolResults: [{ type: 'tool-result', toolName, input, output }] }
      let ops: WorkflowOps | undefined;
      let validation: ValidationResult | undefined;
      for (const step of result.steps) {
        const trs = (step as any)?.toolResults;
        if (!Array.isArray(trs)) continue;
        for (const tr of trs) {
          const out = tr?.output;
          if (out?.ok === true && out?.ops) {
            ops = out.ops as WorkflowOps;
            validation = { valid: true, errors: [], warnings: out.warnings || [], ops };
          }
        }
      }

      const finalText = result.text?.trim() || '';

      // Agent asked a question (no ops) → Cách A
      if (!ops) {
        emit('final', finalText ? 'Agent cần làm rõ yêu cầu' : 'Agent không đề xuất thao tác nào');
        return {
          success: true,
          question: finalText || 'Yêu cầu chưa đủ rõ — bạn mô tả cụ thể hơn được không?',
          summary: finalText,
          steps,
        };
      }

      emit('final', 'Hoàn tất — chờ người dùng áp dụng');
      return {
        success: true,
        ops,
        summary: finalText || 'Đã đề xuất thao tác.',
        steps,
        validation,
      };
    } catch (err: any) {
      Logger.error(`[WorkflowAgent] runTurn failed: ${err?.message}`);
      emit('final', `Lỗi: ${err?.message || 'không xác định'}`);
      return {
        success: false,
        error: err?.message || 'Lỗi agent',
        steps,
      };
    }
  }
}

export default WorkflowAgentService;
