/**
 * workflowAIValidator.ts
 *
 * Pure validator for AI-proposed workflow operations (5 verbs).
 * Runs BEFORE anything touches the canvas — the agent loop calls this
 * inside its apply_operations tool so errors flow back to the model
 * for in-loop self-correction.
 *
 * Pure functions only — no Electron, no IPC, no DB. Unit-testable.
 */

// ── Node catalog access (workflowConfig lives in the UI tree but is a
//    plain data module — safe to require from the main process) ────────────
import { NODE_GROUPS, DEFAULT_CONFIGS } from '../../ui/components/workflow/workflowConfig';

export interface WfNode { id: string; type: string; label?: string; config?: Record<string, any>; }
export interface WfEdge { source: string; sourceHandle?: string; target: string; }

export interface AddOp { nodes: WfNode[]; edges: WfEdge[]; }
export interface UpdateOp { nodeId: string; label?: string; config?: Record<string, any>; }
export interface DeleteOp { nodeIds: string[]; }
export interface RewireOp { edges: WfEdge[]; }
export interface DeleteEdgesOp { source: string; target: string; }

export interface WorkflowOps {
  add?: AddOp;
  update?: UpdateOp[];
  delete?: DeleteOp;
  rewire?: RewireOp;
  deleteEdges?: DeleteEdgesOp[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Normalized ops (ids trimmed, defaults filled) — safe to apply */
  ops: WorkflowOps | null;
}

// ── Catalog helpers ─────────────────────────────────────────────────────────

export function channelFilter(item: { channel?: string }, channel: string): boolean {
  if (!item.channel || item.channel === 'both') return true;
  return item.channel === channel;
}

/** All node types available on the given channel */
export function nodeTypesForChannel(channel: string): Set<string> {
  const types = new Set<string>();
  for (const g of NODE_GROUPS) {
    for (const it of g.items) {
      if (channelFilter(it, channel)) types.add(it.type);
    }
  }
  return types;
}

/** Compact catalog string for prompts: type | label | desc | config keys */
export function buildNodeCatalog(channel: string): string {
  return NODE_GROUPS.map(g => {
    const items = g.items
      .filter(it => channelFilter(it, channel))
      .map(it => {
        const cfgKeys = Object.keys(DEFAULT_CONFIGS[it.type] || {});
        return `  - type: "${it.type}"  |  label: "${it.label}"  |  desc: "${it.desc}"${cfgKeys.length ? `  |  config keys: [${cfgKeys.join(', ')}]` : ''}`;
      });
    if (items.length === 0) return null;
    return `## ${g.label}\n${items.join('\n')}`;
  }).filter(Boolean).join('\n\n');
}

// ── Cycle detection (topological sort) ─────────────────────────────────────

/** Returns true if adding `extraEdges` to `edges` creates a cycle. */
export function wouldCreateCycle(edges: WfEdge[], extraEdges: WfEdge[]): boolean {
  const all = [...edges, ...extraEdges];
  // Build adjacency over node ids referenced
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const e of all) { nodes.add(e.source); nodes.add(e.target); }
  for (const n of nodes) adj.set(n, []);
  for (const e of all) adj.get(e.source)?.push(e.target);

  // Kahn's algorithm
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n, 0);
  for (const e of all) indeg.set(e.target, (indeg.get(e.target) || 0) + 1);
  const queue = [...nodes].filter(n => (indeg.get(n) || 0) === 0);
  let processed = 0;
  while (queue.length) {
    const n = queue.shift()!;
    processed++;
    for (const m of adj.get(n) || []) {
      indeg.set(m, (indeg.get(m) || 0) - 1);
      if ((indeg.get(m) || 0) === 0) queue.push(m);
    }
  }
  return processed !== nodes.size;
}

// ── Main validator ──────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_\u00C0-\u024F\u1E00-\u1EFF-]+$/;

export function validateWorkflowOps(
  ops: any,
  currentNodes: WfNode[],
  currentEdges: WfEdge[],
  channel: string,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!ops || typeof ops !== 'object') {
    return { valid: false, errors: ['Operations phải là JSON object'], warnings, ops: null };
  }

  const allowedTypes = nodeTypesForChannel(channel);
  const existingIds = new Set(currentNodes.map(n => String(n.id)));

  // Normalized ops being built
  const out: WorkflowOps = {};

  // ── add ────────────────────────────────────────────────────────────────
  if (ops.add != null) {
    const addNodes: WfNode[] = [];
    const addEdges: WfEdge[] = [];
    const newIds = new Set<string>();
    const existingEdgesKey = new Set(currentEdges.map(e => `${e.source}->${e.target}`));

    if (!Array.isArray(ops.add.nodes)) {
      errors.push('add.nodes phải là mảng');
    } else {
      ops.add.nodes.forEach((n: any, i: number) => {
        if (!n || typeof n !== 'object') { errors.push(`add.nodes[${i}] không hợp lệ`); return; }
        const id = String(n.id || '').trim();
        const type = String(n.type || '').trim();
        if (!ID_RE.test(id)) { errors.push(`add.nodes[${i}]: id "${id}" không hợp lệ (chứa ký tự lạ)`); return; }
        if (existingIds.has(id) || newIds.has(id)) { errors.push(`add.nodes[${i}]: id "${id}" bị trùng với node hiện có/đã khai báo`); return; }
        if (!allowedTypes.has(type)) {
          errors.push(`add.nodes[${i}]: node type "${type}" không tồn tại trên kênh ${channel}. Xem lại danh mục node.`);
          return;
        }
        newIds.add(id);

        // Config keys check (warn only — extra keys are tolerated, missing keys get defaults)
        const defCfg = DEFAULT_CONFIGS[type] || {};
        const cfg = (n.config && typeof n.config === 'object') ? n.config : {};
        for (const k of Object.keys(cfg)) {
          if (!(k in defCfg)) warnings.push(`add node "${id}": config key "${k}" không thuộc schema của ${type} (sẽ bị bỏ qua)`);
        }
        const missing = Object.keys(defCfg).filter(k => !(k in cfg));
        if (missing.length) warnings.push(`add node "${id}": thiếu config keys [${missing.join(', ')}] — sẽ dùng giá trị mặc định`);

        addNodes.push({
          id,
          type,
          label: String(n.label || '').trim() || type,
          config: { ...defCfg, ...cfg },
        });
      });
    }

    if (!Array.isArray(ops.add.edges)) {
      if (addNodes.length > 1) warnings.push('add.edges trống — các node mới chưa được nối với nhau');
    } else {
      const sourceHandlesOk = new Set(['default', 'true', 'false']);
      ops.add.edges.forEach((e: any, i: number) => {
        const src = String(e?.source || '').trim();
        const tgt = String(e?.target || '').trim();
        const handle = String(e?.sourceHandle || 'default');
        if (!newIds.has(src) && !existingIds.has(src)) { errors.push(`add.edges[${i}]: source "${src}" không tồn tại`); return; }
        if (!newIds.has(tgt) && !existingIds.has(tgt)) { errors.push(`add.edges[${i}]: target "${tgt}" không tồn tại`); return; }
        if (!sourceHandlesOk.has(handle)) { errors.push(`add.edges[${i}]: sourceHandle "${handle}" không hợp lệ (default|true|false)`); return; }
        const key = `${src}->${tgt}`;
        if (existingEdgesKey.has(key)) { warnings.push(`add.edges[${i}]: ${key} đã tồn tại — bỏ qua`); return; }
        existingEdgesKey.add(key);
        addEdges.push({ source: src, sourceHandle: handle, target: tgt });
      });
    }

    // Cycle check over combined graph
    if (addEdges.length && wouldCreateCycle(currentEdges, addEdges)) {
      errors.push('Phát hiện vòng lặp (cycle) khi nối các node — workflow engine không hỗ trợ loop.');
    }

    if (addNodes.length || addEdges.length) out.add = { nodes: addNodes, edges: addEdges };
  }

  // ── update ─────────────────────────────────────────────────────────────
  if (ops.update != null) {
    const updates: UpdateOp[] = [];
    const arr = Array.isArray(ops.update) ? ops.update : [ops.update];
    arr.forEach((u: any, i: number) => {
      const nodeId = String(u?.nodeId || '').trim();
      if (!nodeId) { errors.push(`update[${i}]: thiếu nodeId`); return; }
      if (!existingIds.has(nodeId)) { errors.push(`update[${i}]: nodeId "${nodeId}" không tồn tại trên canvas`); return; }
      const target = currentNodes.find(n => String(n.id) === nodeId)!;
      if (u.config != null) {
        if (typeof u.config !== 'object' || Array.isArray(u.config)) {
          errors.push(`update[${i}]: config phải là object với FULL config của node`);
          return;
        }
        const defCfg = DEFAULT_CONFIGS[target.type] || {};
        for (const k of Object.keys(u.config)) {
          if (!(k in defCfg)) warnings.push(`update "${nodeId}": config key "${k}" không thuộc schema của ${target.type} (sẽ bị bỏ khi apply)`);
        }
      }
      updates.push({
        nodeId,
        label: u.label != null ? String(u.label).trim() : undefined,
        config: u.config != null ? u.config : undefined,
      });
    });
    if (updates.length) out.update = updates;
  }

  // ── delete ─────────────────────────────────────────────────────────────
  if (ops.delete != null) {
    const ids: string[] = [];
    if (!Array.isArray(ops.delete.nodeIds)) {
      errors.push('delete.nodeIds phải là mảng');
    } else {
      ops.delete.nodeIds.forEach((id: any) => {
        const nid = String(id || '').trim();
        if (!existingIds.has(nid)) { errors.push(`delete: nodeId "${nid}" không tồn tại trên canvas`); return; }
        ids.push(nid);
      });
    }
    if (ids.length) out.delete = { nodeIds: ids };
  }

  // ── rewire ─────────────────────────────────────────────────────────────
  if (ops.rewire != null) {
    const rewires: WfEdge[] = [];
    const sourceHandlesOk = new Set(['default', 'true', 'false']);
    if (!Array.isArray(ops.rewire.edges)) {
      errors.push('rewire.edges phải là mảng');
    } else {
      ops.rewire.edges.forEach((e: any, i: number) => {
        const src = String(e?.source || '').trim();
        const tgt = String(e?.target || '').trim();
        const handle = String(e?.sourceHandle || 'default');
        if (!existingIds.has(src)) { errors.push(`rewire.edges[${i}]: source "${src}" không tồn tại`); return; }
        if (!existingIds.has(tgt)) { errors.push(`rewire.edges[${i}]: target "${tgt}" không tồn tại`); return; }
        if (!sourceHandlesOk.has(handle)) { errors.push(`rewire.edges[${i}]: sourceHandle "${handle}" không hợp lệ`); return; }
        rewires.push({ source: src, sourceHandle: handle, target: tgt });
      });
    }
    // Cycle check: current edges minus deleted + rewires
    const deleteSet = new Set(out.delete?.nodeIds || []);
    const keptEdges = currentEdges.filter(e => !deleteSet.has(e.source) && !deleteSet.has(e.target));
    if (rewires.length && wouldCreateCycle(keptEdges, rewires)) {
      errors.push('Phát hiện vòng lặp (cycle) sau khi nối lại các node.');
    }
    if (rewires.length) out.rewire = { edges: rewires };
  }

  // ── deleteEdges ────────────────────────────────────────────────────────
  if (ops.deleteEdges != null) {
    const delEdges: DeleteEdgesOp[] = [];
    const arr = Array.isArray(ops.deleteEdges) ? ops.deleteEdges : [ops.deleteEdges];
    const currentKeys = new Set(currentEdges.map(e => `${e.source}->${e.target}`));
    arr.forEach((d: any, i: number) => {
      const src = String(d?.source || '').trim();
      const tgt = String(d?.target || '').trim();
      if (!existingIds.has(src)) { errors.push(`deleteEdges[${i}]: source "${src}" không tồn tại`); return; }
      if (!existingIds.has(tgt)) { errors.push(`deleteEdges[${i}]: target "${tgt}" không tồn tại`); return; }
      if (!currentKeys.has(`${src}->${tgt}`)) { warnings.push(`deleteEdges[${i}]: không có edge ${src}->${tgt} trên canvas — bỏ qua`); return; }
      delEdges.push({ source: src, target: tgt });
    });
    if (delEdges.length) out.deleteEdges = delEdges;
  }

  // ── at least one op? ───────────────────────────────────────────────────
  const hasAny = out.add || out.update || out.delete || out.rewire || out.deleteEdges;
  if (!hasAny && errors.length === 0) {
    warnings.push('Không có thao tác nào (add/update/delete/rewire/deleteEdges đều rỗng)');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    ops: errors.length === 0 ? (hasAny ? out : {}) : null,
  };
}
