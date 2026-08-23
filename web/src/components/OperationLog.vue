<template>
  <div class="oplog-wrap">
    <!-- 过滤器 -->
    <div class="oplog-filter">
      <el-date-picker
        v-model="dateRange"
        type="daterange"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        size="small"
        value-format="YYYY-MM-DD"
        style="width:260px"
      />
      <el-select v-model="username" size="small" placeholder="人员" clearable filterable style="width:140px">
        <el-option v-for="u in users" :key="u" :label="u" :value="u" />
      </el-select>
      <el-select v-model="sqlType" size="small" placeholder="SQL 类型" clearable style="width:140px">
        <el-option label="全部" value="" />
        <el-option v-for="t in typeOptions" :key="t.value" :label="t.label" :value="t.value" />
      </el-select>
      <el-input v-model="keyword" size="small" placeholder="搜索 SQL/库/连接" clearable style="width:200px" @keyup.enter="search" />
      <el-button size="small" type="primary" @click="search">查询</el-button>
      <el-button size="small" @click="resetFilter">重置</el-button>
      <div style="flex:1"></div>
      <span class="oplog-stat">共 {{ total }} 条</span>
    </div>

    <!-- 类型统计标签 -->
    <div class="oplog-tags">
      <span v-for="s in stats" :key="s.sql_type" class="oplog-tag" :class="{ active: sqlType === s.sql_type }" @click="sqlType = (sqlType === s.sql_type ? '' : s.sql_type); search()">
        {{ s.sql_type }} <b>{{ s.cnt }}</b>
      </span>
    </div>

    <!-- 表格 -->
    <div class="oplog-table">
      <el-table :data="rows" border stripe size="small" height="100%" @row-dblclick="onRowDbl">
        <el-table-column prop="created_at" label="时间" width="160" fixed />
        <el-table-column prop="username" label="操作人" width="100" />
        <el-table-column prop="conn_name" label="连接" width="120" show-overflow-tooltip />
        <el-table-column prop="database" label="数据库" width="120" show-overflow-tooltip />
        <el-table-column prop="sql_type" label="类型" width="90">
          <template #default="{ row }">
            <el-tag :type="typeTag(row.sql_type)" size="small">{{ row.sql_type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="sql_text" label="SQL 语句" min-width="320" show-overflow-tooltip />
        <el-table-column prop="affected" label="影响行数" width="90" align="right" />
        <el-table-column prop="status" label="状态" width="80" fixed="right">
          <template #default="{ row }">
            <el-tag :type="row.status === 'success' ? 'success' : (row.status === 'partial' ? 'warning' : 'danger')" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 分页 -->
    <div class="oplog-pager">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="size"
        :total="total"
        :page-sizes="[20, 50, 100, 200]"
        layout="total, sizes, prev, pager, next, jumper"
        background
        @current-change="load"
        @size-change="load"
      />
    </div>

    <!-- SQL 详情 -->
    <el-dialog v-model="detailVisible" title="SQL 详情" width="760px" append-to-body>
      <el-descriptions v-if="curRow" :column="2" border size="small">
        <el-descriptions-item label="时间">{{ curRow.created_at }}</el-descriptions-item>
        <el-descriptions-item label="操作人">{{ curRow.username }}</el-descriptions-item>
        <el-descriptions-item label="连接">{{ curRow.conn_name }}</el-descriptions-item>
        <el-descriptions-item label="数据库">{{ curRow.database }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ curRow.sql_type }}</el-descriptions-item>
        <el-descriptions-item label="影响行数">{{ curRow.affected }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ curRow.status }}</el-descriptions-item>
        <el-descriptions-item label="错误" :span="2">{{ curRow.error || '—' }}</el-descriptions-item>
      </el-descriptions>
      <pre v-if="curRow" class="oplog-sql-detail">{{ curRow.sql_text }}</pre>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import api from '../api';

const dateRange = ref([]);
const username = ref('');
const sqlType = ref('');
const keyword = ref('');
const page = ref(1);
const size = ref(50);
const total = ref(0);
const rows = ref([]);
const stats = ref([]);
const users = ref([]);
const detailVisible = ref(false);
const curRow = ref(null);

// 下拉选项：Select/Insert/Update/Delete/Alter/非Select 等
const typeOptions = [
  { label: '非 Select', value: 'NON_SELECT' },
  { label: 'SELECT', value: 'SELECT' },
  { label: 'INSERT', value: 'INSERT' },
  { label: 'UPDATE', value: 'UPDATE' },
  { label: 'DELETE', value: 'DELETE' },
  { label: 'ALTER', value: 'ALTER' },
  { label: 'CREATE', value: 'CREATE' },
  { label: 'DROP', value: 'DROP' },
  { label: 'TRUNCATE', value: 'TRUNCATE' },
  { label: '其他', value: 'OTHER' }
];

function typeTag(t) {
  const m = {
    SELECT: 'info', INSERT: 'success', UPDATE: 'warning', DELETE: 'danger',
    ALTER: 'warning', CREATE: 'primary', DROP: 'danger', TRUNCATE: 'danger', OTHER: 'info'
  };
  return m[t] || 'info';
}

async function load() {
  try {
    const data = await api.getLogs({
      startDate: dateRange.value?.[0] || '',
      endDate: dateRange.value?.[1] || '',
      username: username.value,
      sqlType: sqlType.value,
      keyword: keyword.value,
      page: page.value,
      size: size.value
    });
    rows.value = data.rows || [];
    total.value = data.total || 0;
    stats.value = data.stats || [];
  } catch (e) { ElMessage.error('加载日志失败：' + e.message); }
}

async function loadUsers() {
  try { users.value = await api.getLogUsers(); } catch (e) {}
}

function search() { page.value = 1; load(); }
function resetFilter() {
  dateRange.value = []; username.value = ''; sqlType.value = ''; keyword.value = '';
  page.value = 1; load();
}
function onRowDbl(row) { curRow.value = row; detailVisible.value = true; }

onMounted(() => { loadUsers(); load(); });
</script>

<style scoped>
.oplog-wrap { height:100%; display:flex; flex-direction:column; background:#fff; overflow:hidden; }
.oplog-filter { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid var(--c-border,#E5E7EB); flex-shrink:0; }
.oplog-stat { font-size:12px; color:var(--c-text-3,#64748B); }
.oplog-tags { display:flex; gap:6px; padding:8px 14px; border-bottom:1px solid var(--c-border,#E5E7EB); flex-shrink:0; flex-wrap:wrap; }
.oplog-tag { font-size:12px; padding:2px 10px; border-radius:12px; background:#F1F5F9; color:#64748B; cursor:pointer; user-select:none; }
.oplog-tag b { color:#007AFF; margin-left:4px; }
.oplog-tag:hover { background:#E0EBFF; }
.oplog-tag.active { background:#007AFF; color:#fff; }
.oplog-tag.active b { color:#fff; }
.oplog-table { flex:1; min-height:0; overflow:hidden; padding:0 14px; }
.oplog-pager { display:flex; justify-content:flex-end; padding:8px 14px; border-top:1px solid var(--c-border,#E5E7EB); flex-shrink:0; }
.oplog-sql-detail { background:#0d1117; color:#c9d1d3; padding:12px 16px; border-radius:6px; font-size:13px; line-height:1.6; white-space:pre-wrap; word-break:break-all; margin-top:12px; max-height:360px; overflow:auto; }
</style>
