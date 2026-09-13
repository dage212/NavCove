<template>
  <div class="relation-view">
    <div v-loading="loading" class="rel-inner">
      <div class="sv-meta">
        <el-tag type="warning" size="small">{{ t('relation.tag') }}</el-tag>
        <span class="sv-title">{{ tab.database }}.{{ tab.table }}</span>
        <span class="sv-meta-item">{{ t('relation.outCount') }}<b>{{ outgoing.length }}</b></span>
        <span class="sv-meta-item">{{ t('relation.inCount') }}<b>{{ incoming.length }}</b></span>
        <div style="flex:1"></div>
        <el-button size="small" @click="load"><el-icon><Refresh /></el-icon><span style="margin-left:4px">{{ t('common.refresh') }}</span></el-button>
      </div>

      <div v-if="!loading && !outgoing.length && !incoming.length" class="rel-empty">
        {{ t('relation.empty') }}
      </div>

      <div v-else class="sv-section">
        <div class="sv-sec-title">
          <el-icon><Share /></el-icon><span>{{ t('relation.chart') }}</span>
          <span class="rel-hint">{{ t('relation.chartHint') }}</span>
        </div>
        <div
          ref="boardRef"
          class="er-board"
          :class="{ 'is-panning': panning }"
          @mousedown="onBoardDown"
          @wheel.prevent="onBoardWheel"
        >
          <div
            ref="worldRef"
            class="er-world"
            :style="{ width: worldSize.w + 'px', height: worldSize.h + 'px', transform: `translate(${pan.x}px, ${pan.y}px)` }"
          >
          <svg class="er-svg" :width="svgSize.w" :height="svgSize.h">
            <defs>
              <marker id="er-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="#007AFF" />
              </marker>
              <marker id="er-arrow-muted" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="#94A3B8" />
              </marker>
            </defs>
            <path
              v-for="(ln, i) in lines"
              :key="'p-' + i"
              :d="ln.d"
              fill="none"
              :stroke="ln.active ? '#007AFF' : '#94A3B8'"
              :stroke-width="ln.active ? 1.8 : 1.2"
              :marker-end="ln.active ? 'url(#er-arrow)' : 'url(#er-arrow-muted)'"
            />
            <text
              v-for="(ln, i) in lines"
              v-show="ln.label"
              :key="'t-' + i"
              :x="ln.lx"
              :y="ln.ly"
              text-anchor="middle"
              class="er-line-label"
            >{{ ln.label }}</text>
          </svg>
          <div
            v-for="tbl in allTables"
            :key="tbl.id"
            class="er-card"
            :class="{ 'is-current': tbl.current, 'is-dragging': dragId === tbl.id }"
            :style="cardStyle(tbl)"
            @mousedown.stop.prevent="onCardDown($event, tbl)"
          >
            <div class="er-head">{{ tbl.table }}</div>
            <div
              v-for="c in fieldList(tbl)"
              :key="c.name"
              class="er-field"
              :class="fieldClass(tbl, c)"
              :data-fid="fieldKey(tbl, c.name)"
              :title="c.type || ''"
            >
              <i class="port left" />
                <span class="er-name">{{ c.name }}</span>
                <span v-if="c.key === 'PRI'" class="er-pk">PK</span>
                <span v-if="isSelfFk(tbl, c)" class="er-self">{{ t('relation.self') }}</span>
              <i class="port right" />
            </div>
          </div>
          </div>
        </div>
      </div>

      <div class="sv-section">
        <div class="sv-sec-title"><el-icon><Share /></el-icon><span>{{ t('relation.outgoing') }}</span></div>
        <el-table :data="outgoing" size="small" border stripe :empty-text="t('relation.none')">
          <el-table-column prop="name" :label="t('relation.fkName')" min-width="160" show-overflow-tooltip />
          <el-table-column prop="columnsText" :label="t('relation.localCols')" min-width="140" show-overflow-tooltip />
          <el-table-column :label="t('relation.refTable')" min-width="180">
            <template #default="{ row }">
              <el-button link type="primary" @click="openRelated(row.refSchema, row.refTable)">{{ row.refSchema }}.{{ row.refTable }}</el-button>
            </template>
          </el-table-column>
          <el-table-column prop="refColumnsText" :label="t('relation.refCols')" min-width="140" show-overflow-tooltip />
          <el-table-column prop="updateRule" :label="t('relation.onUpdate')" width="110" />
          <el-table-column prop="deleteRule" :label="t('relation.onDelete')" width="110" />
        </el-table>
      </div>

      <div class="sv-section">
        <div class="sv-sec-title"><el-icon><Share /></el-icon><span>{{ t('relation.incoming') }}</span></div>
        <el-table :data="incoming" size="small" border stripe :empty-text="t('relation.none')">
          <el-table-column prop="name" :label="t('relation.fkName')" min-width="160" show-overflow-tooltip />
          <el-table-column :label="t('relation.fromTable')" min-width="180">
            <template #default="{ row }">
              <el-button link type="primary" @click="openRelated(row.tableSchema, row.tableName)">{{ row.tableSchema }}.{{ row.tableName }}</el-button>
            </template>
          </el-table-column>
          <el-table-column prop="columnsText" :label="t('relation.localCols')" min-width="140" show-overflow-tooltip />
          <el-table-column prop="refColumnsText" :label="t('relation.refCols')" min-width="140" show-overflow-tooltip />
          <el-table-column prop="updateRule" :label="t('relation.onUpdate')" width="110" />
          <el-table-column prop="deleteRule" :label="t('relation.onDelete')" width="110" />
        </el-table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { ElMessage } from 'element-plus';
import api from '../api';
import { t } from '../i18n';

const props = defineProps({
  tab: Object,
  connId: String
});
const emit = defineEmits(['open-table']);

const loading = ref(true);
const outgoing = ref([]);
const incoming = ref([]);
const graph = ref({ nodes: [], edges: [] });
const boardRef = ref(null);
const worldRef = ref(null);
const lines = ref([]);
const svgSize = ref({ w: 0, h: 0 });
const worldSize = ref({ w: 900, h: 480 });
const positions = ref({});
const pan = ref({ x: 24, y: 20 });
const panning = ref(false);
const dragId = ref('');
let ro = null;
let dragRaf = 0;

const CARD_W = 200;
const HEAD_H = 30;
const ROW_H = 24;
const COL_GAP = 300;
const PACK_GAP = 36;

function nodeId(schema, name) {
  return `${schema}.${name}`;
}
function fieldKey(tbl, col) {
  return `${tbl.database}.${tbl.table}::${col}`;
}

const fkFieldSet = computed(() => {
  const s = new Set();
  for (const e of graph.value.edges || []) {
    (e.columns || []).forEach((col) => s.add(`${e.tableSchema}.${e.tableName}::${col}`));
    (e.refColumns || []).forEach((col) => s.add(`${e.refSchema}.${e.refTable}::${col}`));
  }
  return s;
});

function fieldList(tbl) {
  return (tbl.columns && tbl.columns.length) ? tbl.columns : [{ name: '—', key: '', type: '' }];
}
function fieldClass(tbl, c) {
  return {
    'is-pk': c.key === 'PRI',
    'is-fk': fkFieldSet.value.has(fieldKey(tbl, c.name)),
    'is-self': isSelfFk(tbl, c)
  };
}

function isSelfFk(tbl, c) {
  return (graph.value.edges || []).some((e) =>
    e.tableSchema === tbl.database && e.tableName === tbl.table
    && e.refSchema === tbl.database && e.refTable === tbl.table
    && (e.columns || []).includes(c.name)
  );
}

const classified = computed(() => {
  const nodes = graph.value.nodes || [];
  const current = nodes.filter((n) => n.current);
  const currentId = current[0] && current[0].id;
  const outIds = new Set();
  const inIds = new Set();
  for (const fk of outgoing.value || []) {
    const id = nodeId(fk.refSchema, fk.refTable);
    if (id !== currentId) outIds.add(id);
  }
  for (const fk of incoming.value || []) {
    const id = nodeId(fk.tableSchema, fk.tableName);
    if (id !== currentId) inIds.add(id);
  }
  const left = [];
  const right = [];
  const hop = [];
  for (const n of nodes) {
    if (n.current) continue;
    const inn = inIds.has(n.id);
    const out = outIds.has(n.id);
    if (inn && !out) left.push(n);
    else if (out && !inn) right.push(n);
    else if (out && inn) right.push(n);
    else hop.push(n);
  }
  return { left, center: current, right, hop };
});

const leftTables = computed(() => classified.value.left);
const centerTables = computed(() => classified.value.center);
const rightTables = computed(() => classified.value.right);
const hopTables = computed(() => classified.value.hop);
const allTables = computed(() => [...leftTables.value, ...centerTables.value, ...rightTables.value, ...hopTables.value]);

function cardHeight(tbl) {
  return HEAD_H + fieldList(tbl).length * ROW_H;
}

function fieldIndex(tbl, col) {
  if (!tbl || !col) return 0;
  const i = fieldList(tbl).findIndex((c) => c.name === col);
  return i < 0 ? 0 : i;
}

function avgAnchor(tbl, kind, current) {
  if (!current) return 0;
  const edges = graph.value.edges || [];
  const scores = [];
  for (const e of edges) {
    const srcId = nodeId(e.tableSchema, e.tableName);
    const dstId = nodeId(e.refSchema, e.refTable);
    if (kind === 'out' && srcId === current.id && dstId === tbl.id) {
      scores.push(fieldIndex(current, (e.columns || [])[0]));
    }
    if (kind === 'in' && dstId === current.id && srcId === tbl.id) {
      scores.push(fieldIndex(current, (e.refColumns || [])[0]));
    }
    if (kind === 'hop') {
      if (srcId === tbl.id || dstId === tbl.id) {
        scores.push(fieldIndex(tbl, srcId === tbl.id ? (e.columns || [])[0] : (e.refColumns || [])[0]));
      }
    }
  }
  if (!scores.length) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function packColumn(items) {
  items.sort((a, b) => a.sort - b.sort || a.y - b.y);
  let bottom = 16;
  for (const it of items) {
    it.y = Math.max(it.y, bottom);
    bottom = it.y + it.h + PACK_GAP;
  }
}

function layoutInitial() {
  const current = centerTables.value[0];
  const pos = {};
  const currentY = 48;
  const step = CARD_W + COL_GAP;
  const leftIds = new Set(leftTables.value.map((n) => n.id));
  const rightIds = new Set(rightTables.value.map((n) => n.id));
  const hopLeft = [];
  const hopRight = [];
  for (const t of hopTables.value) {
    let l = 0;
    let r = 0;
    for (const e of graph.value.edges || []) {
      const s = nodeId(e.tableSchema, e.tableName);
      const d = nodeId(e.refSchema, e.refTable);
      const other = s === t.id ? d : (d === t.id ? s : null);
      if (!other) continue;
      if (leftIds.has(other)) l += 1;
      if (rightIds.has(other) || (current && other === current.id)) r += 1;
    }
    if (l > r) hopLeft.push(t);
    else hopRight.push(t);
  }
  let col = 0;
  const xHopLeft = hopLeft.length ? 48 + step * col++ : 48;
  const xLeft = leftTables.value.length ? 48 + step * col++ : 48;
  const xCenter = 48 + step * col++;
  const xRight = rightTables.value.length ? 48 + step * col++ : xCenter;
  const xHopRight = hopRight.length ? 48 + step * col : xRight;
  if (current) pos[current.id] = { x: xCenter, y: currentY };

  const leftItems = leftTables.value.map((t) => {
    const sort = avgAnchor(t, 'in', current);
    const alignCol = (incoming.value.find((fk) => nodeId(fk.tableSchema, fk.tableName) === t.id)?.columns || [])[0];
    const curCol = (incoming.value.find((fk) => nodeId(fk.tableSchema, fk.tableName) === t.id)?.refColumns || [])[0];
    const y = current
      ? currentY + HEAD_H + fieldIndex(current, curCol) * ROW_H - (HEAD_H + fieldIndex(t, alignCol) * ROW_H)
      : 16;
    return { id: t.id, y, h: cardHeight(t), sort };
  });
  const rightItems = rightTables.value.map((t) => {
    const sort = avgAnchor(t, 'out', current);
    const fk = (outgoing.value || []).find((e) => nodeId(e.refSchema, e.refTable) === t.id);
    const srcCol = fk && (fk.columns || [])[0];
    const dstCol = fk && (fk.refColumns || [])[0];
    const y = current
      ? currentY + HEAD_H + fieldIndex(current, srcCol) * ROW_H - (HEAD_H + fieldIndex(t, dstCol) * ROW_H)
      : 16;
    return { id: t.id, y, h: cardHeight(t), sort };
  });
  const hopLeftItems = hopLeft.map((t, i) => ({
    id: t.id,
    y: 16 + i * 20,
    h: cardHeight(t),
    sort: avgAnchor(t, 'hop', current)
  }));
  const hopRightItems = hopRight.map((t, i) => ({
    id: t.id,
    y: 16 + i * 20,
    h: cardHeight(t),
    sort: avgAnchor(t, 'hop', current)
  }));

  packColumn(leftItems);
  packColumn(rightItems);
  packColumn(hopLeftItems);
  packColumn(hopRightItems);

  leftItems.forEach((it) => { pos[it.id] = { x: xLeft, y: Math.max(16, it.y) }; });
  rightItems.forEach((it) => { pos[it.id] = { x: xRight, y: Math.max(16, it.y) }; });
  hopLeftItems.forEach((it) => { pos[it.id] = { x: xHopLeft, y: Math.max(16, it.y) }; });
  hopRightItems.forEach((it) => { pos[it.id] = { x: xHopRight, y: Math.max(16, it.y) }; });
  positions.value = pos;
  pan.value = { x: 20, y: 16 };
}

function cardStyle(tbl) {
  const p = positions.value[tbl.id] || { x: 0, y: 0 };
  return {
    left: p.x + 'px',
    top: p.y + 'px',
    width: CARD_W + 'px',
    zIndex: dragId.value === tbl.id ? 5 : 2
  };
}

async function load() {
  if (!props.connId || !props.tab) return;
  loading.value = true;
  try {
    const r = await api.getTableRelations(props.connId, props.tab.database, props.tab.table);
    outgoing.value = (r && r.outgoing) || [];
    incoming.value = (r && r.incoming) || [];
    graph.value = (r && r.graph) || { nodes: [], edges: [] };
    layoutInitial();
    await nextTick();
    drawLines();
  } catch (e) {
    ElMessage.error(t('relation.loadFail', { message: e.message || e }));
  } finally {
    loading.value = false;
    await nextTick();
    if (boardRef.value && ro) ro.observe(boardRef.value);
    drawLines();
  }
}

function openRelated(database, table) {
  if (!database || !table) return;
  emit('open-table', { database, name: table, type: 'table' });
}

function onBoardDown(e) {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const origin = { ...pan.value };
  panning.value = true;
  function onMove(ev) {
    pan.value = { x: origin.x + ev.clientX - startX, y: origin.y + ev.clientY - startY };
  }
  function onUp() {
    panning.value = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'grabbing';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function onBoardWheel(e) {
  pan.value = { x: pan.value.x - e.deltaX, y: pan.value.y - e.deltaY };
}

function onCardDown(e, tbl) {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const origin = { ...(positions.value[tbl.id] || { x: 0, y: 0 }) };
  let moved = false;
  dragId.value = tbl.id;

  function onMove(ev) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    positions.value = {
      ...positions.value,
      [tbl.id]: { x: Math.max(8, origin.x + dx), y: Math.max(8, origin.y + dy) }
    };
    if (!dragRaf) {
      dragRaf = requestAnimationFrame(() => {
        dragRaf = 0;
        drawLines();
      });
    }
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    dragId.value = '';
    drawLines();
    if (!moved && !tbl.current) openRelated(tbl.database, tbl.table);
  }
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'grabbing';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function portPoint(fid, side) {
  const world = worldRef.value;
  if (!world) return null;
  const field = world.querySelector(`[data-fid="${CSS.escape(fid)}"]`);
  if (!field) return null;
  const port = field.querySelector(`.port.${side}`);
  const el = port || field;
  const wr = world.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return {
    x: r.left - wr.left + r.width / 2,
    y: r.top - wr.top + r.height / 2
  };
}

function curve(a, b, self) {
  if (self) {
    const bulge = 80;
    return {
      d: `M ${a.x} ${a.y} C ${a.x + bulge} ${a.y}, ${b.x + bulge} ${b.y}, ${b.x} ${b.y}`,
      lx: a.x + bulge + 2,
      ly: (a.y + b.y) / 2
    };
  }
  const span = Math.abs(b.x - a.x);
  const mid = (a.x + b.x) / 2;
  const pull = Math.max(80, span * 0.42);
  const c1x = a.x + (b.x >= a.x ? pull : -pull);
  const c2x = b.x + (b.x >= a.x ? -pull : pull);
  const d = `M ${a.x} ${a.y} C ${c1x} ${a.y}, ${c2x} ${b.y}, ${b.x} ${b.y}`;
  return { d, lx: mid, ly: (a.y + b.y) / 2 - 8 };
}

function drawLines() {
  if (!worldRef.value) { lines.value = []; return; }
  let maxX = 720;
  let maxY = 280;
  for (const tbl of allTables.value) {
    const p = positions.value[tbl.id];
    if (!p) continue;
    maxX = Math.max(maxX, p.x + CARD_W + 120);
    maxY = Math.max(maxY, p.y + cardHeight(tbl) + 48);
  }
  worldSize.value = { w: maxX, h: maxY };
  svgSize.value = { w: maxX, h: maxY };
  const currentId = nodeId(props.tab.database, props.tab.table);
  const next = [];
  for (const e of graph.value.edges || []) {
    const cols = e.columns && e.columns.length ? e.columns : [null];
    cols.forEach((col, i) => {
      const srcId = col
        ? `${e.tableSchema}.${e.tableName}::${col}`
        : `${e.tableSchema}.${e.tableName}`;
      const refCol = (e.refColumns && e.refColumns[i]) || (e.refColumns && e.refColumns[0]);
      const dstId = refCol
        ? `${e.refSchema}.${e.refTable}::${refCol}`
        : `${e.refSchema}.${e.refTable}`;
      const self = e.tableSchema === e.refSchema && e.tableName === e.refTable;
      const srcRight = portPoint(srcId, 'right');
      const srcLeft = portPoint(srcId, 'left');
      const dstRight = portPoint(dstId, 'right');
      const dstLeft = portPoint(dstId, 'left');
      if (!srcRight || !dstLeft) return;
      let a = srcRight;
      let b = dstLeft;
      if (self) {
        a = srcRight;
        b = dstRight || dstLeft;
      } else if (srcRight.x > dstLeft.x) {
        a = srcLeft;
        b = dstRight;
      }
      if (!a || !b) return;
      const involved = nodeId(e.tableSchema, e.tableName) === currentId || nodeId(e.refSchema, e.refTable) === currentId;
      const path = curve(a, b, self);
      next.push({
        d: path.d,
        lx: path.lx,
        ly: path.ly,
        active: involved,
        label: self ? `${col || ''} → ${refCol || ''} ${t('relation.self')}` : ''
      });
    });
  }
  lines.value = next;
}

function onWinResize() { drawLines(); }

watch(() => [props.tab, props.connId], () => load());
onMounted(() => {
  load();
  window.addEventListener('resize', onWinResize);
  ro = new ResizeObserver(() => drawLines());
});
onUnmounted(() => {
  window.removeEventListener('resize', onWinResize);
  if (ro) ro.disconnect();
  if (dragRaf) cancelAnimationFrame(dragRaf);
});
</script>

<style scoped>
.relation-view { height: 100%; overflow: auto; padding: 12px; }
.rel-inner { display: flex; flex-direction: column; gap: 12px; }
.sv-meta { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #F1F5F9; border-radius: 6px; font-size: 13px; color: #64748B; }
.sv-title { font-weight: 600; color: #111827; font-size: 14px; }
.sv-meta-item { color: #64748B; }
.sv-meta-item b { color: #111827; margin: 0 2px; }
.sv-section { border: 1px solid #E5E7EB; border-radius: 6px; overflow: hidden; }
.sv-sec-title { display: flex; align-items: center; gap: 6px; padding: 8px 12px; background: #FAFAFA; border-bottom: 1px solid #E5E7EB; font-size: 13px; color: #111827; font-weight: 500; }
.rel-hint { margin-left: 8px; font-size: 12px; color: #94A3B8; font-weight: 400; }
.rel-empty { padding: 36px 12px; text-align: center; color: #94A3B8; font-size: 13px; }

.er-board {
  position: relative;
  height: 480px;
  overflow: hidden;
  background:
    radial-gradient(circle, #E2E8F0 1px, transparent 1.5px) 0 0 / 18px 18px,
    #fff;
  cursor: grab;
}
.er-board.is-panning { cursor: grabbing; }
.er-world { position: relative; transform-origin: 0 0; }
.er-svg { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; z-index: 3; }
.er-line-label { fill: #007AFF; font-size: 10px; font-weight: 600; }
.er-card {
  position: absolute;
  border: 1px solid #E5E7EB;
  border-radius: 6px;
  overflow: visible;
  background: #fff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, .04);
  cursor: grab;
  user-select: none;
}
.er-card.is-current { border-color: #007AFF; }
.er-card.is-dragging { cursor: grabbing; box-shadow: 0 8px 20px rgba(15, 23, 42, .16); }
.er-head {
  background: #334155;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  padding: 7px 10px;
  border-radius: 6px 6px 0 0;
}
.er-card.is-current .er-head { background: #007AFF; }
.er-field {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 2px 14px;
  font-size: 12px;
  color: #334155;
  border-top: 1px solid #F1F5F9;
}
.er-field.is-fk { background: #F0F7FF; color: #007AFF; }
.er-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.er-pk { font-size: 10px; font-weight: 600; color: #fff; background: #F59E0B; border-radius: 2px; padding: 0 4px; line-height: 16px; }
.er-self { font-size: 10px; font-weight: 600; color: #007AFF; background: #E8F1FF; border-radius: 2px; padding: 0 4px; line-height: 16px; }
.port {
  position: absolute;
  top: 50%;
  width: 8px;
  height: 8px;
  margin-top: -4px;
  border-radius: 50%;
  background: #CBD5E1;
  border: 1px solid #fff;
}
.er-field.is-fk .port { background: #007AFF; }
.port.left { left: -4px; }
.port.right { right: -4px; }
</style>
