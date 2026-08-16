<template>
  <el-dialog
    :model-value="visible"
    @update:model-value="$emit('update:visible', $event)"
    title="新建表"
    width="900px"
    :close-on-click-modal="false"
    @open="onOpen"
    @closed="onClosed"
    destroy-on-close
  >
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
      <span style="color:#5e6c84;font-size:13px;">目标库：</span>
      <el-tag size="small">{{ database }}</el-tag>
      <span style="color:#86909c;font-size:12px;margin-left:auto;">
        快捷键：Ctrl + Enter / Cmd + Enter 执行
      </span>
    </div>
    <div class="create-editor-wrapper">
      <textarea ref="editorRef" class="create-editor-textarea" />
    </div>
    <div v-if="resultLogs.length" style="margin-top:12px;max-height:160px;overflow:auto;">
      <div
        v-for="(log, i) in resultLogs"
        :key="i"
        :class="['log-item', log.ok ? 'log-ok' : 'log-err']"
      >
        <span class="log-time">{{ log.time }}</span>
        <span class="log-tag">{{ log.ok ? '成功' : '失败' }}</span>
        <span class="log-msg">{{ log.msg }}</span>
      </div>
    </div>
    <template #footer>
      <div class="conn-dialog-footer">
        <el-button @click="onCancel">取消</el-button>
        <el-button type="primary" @click="runExecute" :loading="executing">
          <el-icon><VideoPlay /></el-icon>
          <span style="margin-left:4px">执行</span>
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, nextTick } from 'vue';
import { ElMessage } from 'element-plus';
import { VideoPlay } from '@element-plus/icons-vue';
import CodeMirror from 'codemirror';
import 'codemirror/lib/codemirror.css';
import 'codemirror/mode/sql/sql.js';
import 'codemirror/addon/edit/matchbrackets.js';
import 'codemirror/addon/edit/closebrackets.js';
import 'codemirror/addon/hint/show-hint.css';
import 'codemirror/addon/hint/show-hint.js';
import 'codemirror/addon/hint/sql-hint.js';
import api from '../api';

const props = defineProps({
  visible: Boolean,
  conn: Object,
  database: String
});
const emit = defineEmits(['update:visible', 'done']);

const editorRef = ref(null);
const executing = ref(false);
const resultLogs = ref([]);
let cmInstance = null;

function defaultTemplate(db) {
  const q = (n) => '`' + String(n || '').replace(/`/g, '') + '`';
  return `-- 在下方编写 CREATE TABLE / ALTER TABLE 等 DDL 语句，按 Ctrl+Enter 或点"执行"按钮运行
-- 注意：如果不加库名前缀，默认会对当前库（${q(db)}）执行

CREATE TABLE ${q(db)}.\`new_table_name\` (
  \`id\` INT NOT NULL AUTO_INCREMENT COMMENT '主键 id',
  \`name\` VARCHAR(255) NOT NULL COMMENT '名称',
  \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (\`id\`),
  KEY \`idx_name\` (\`name\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='请修改表名与字段';
`;
}

async function onOpen() {
  resultLogs.value = [];
  await nextTick();
  if (!editorRef.value) return;
  if (!cmInstance) {
    cmInstance = CodeMirror.fromTextArea(editorRef.value, {
      mode: 'text/x-mysql',
      theme: 'navcove',
      lineNumbers: true,
      indentUnit: 2,
      smartIndent: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      placeholder: '在此输入 CREATE TABLE ...',
      extraKeys: {
        'Ctrl-Enter': () => runExecute(),
        'Cmd-Enter': () => runExecute(),
        'Ctrl-Space': 'autocomplete',
        'Tab': (cm) => {
          if (cm.somethingSelected()) cm.indentSelection('add');
          else cm.replaceSelection('  ', 'end');
        }
      }
    });
    cmInstance.on('change', () => {
      if (cmInstance) cmInstance.save(); // 同步回 textarea
    });
  }
  cmInstance.setValue(defaultTemplate(props.database));
  cmInstance.focus();
  // 触发 CodeMirror 内部重新计算高度（否则第一次打开可能高度不正确）
  setTimeout(() => cmInstance && cmInstance.refresh(), 100);
}

function onClosed() {
  // 销毁实例，下次打开重新 init（避免 dialog 复用造成样式错乱、resize 失效）
  if (cmInstance) {
    try { cmInstance.toTextArea(); } catch (e) {}
    cmInstance = null;
  }
  resultLogs.value = [];
}

function onCancel() {
  if (executing.value) {
    ElMessage.warning('正在执行，请稍候');
    return;
  }
  emit('update:visible', false);
}

function pushLog(ok, msg) {
  const now = new Date();
  const time = String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':' +
    String(now.getSeconds()).padStart(2, '0');
  resultLogs.value.push({ ok, msg, time });
  if (resultLogs.value.length > 50) resultLogs.value.shift();
}

async function runExecute() {
  if (!props.conn || !props.conn.id) { ElMessage.error('未连接数据库'); return; }
  if (!cmInstance) return;
  const sql = cmInstance.getValue().trim();
  if (!sql) { ElMessage.warning('请输入 SQL 语句'); return; }
  executing.value = true;
  try {
    const res = await api.query(props.conn.id, props.database, sql);
    // executeSql 返回数组（多语句时），逐个展示日志
    const list = Array.isArray(res) ? res : [res];
    // 表名识别：直接基于用户编写的原始 SQL 文本解析（executeSql 结果不带 sql 字段）
    let createdTable = null;
    const firstCreateMatch = sql.match(/create\s+table(?:\s+if\s+not\s+exists)?\s+(?:`?([\w$]+)`?\.)?\s*`?([\w$]+)`?/i);
    if (firstCreateMatch) createdTable = firstCreateMatch[2];

    list.forEach((item, idx) => {
      if (item && typeof item === 'object') {
        // 后端字段：SELECT 型给 rows/fields/affected；WRITE 型给 affected/insertId/changed/warning
        const isSelect = item.type === 'select' || Array.isArray(item.rows);
        const count = item.affected != null ? item.affected : (item.affectedRows != null ? item.affectedRows : (item.rows ? item.rows.length : null));
        const typeTag = item.type ? `[${item.type.toUpperCase()}] ` : '';
        const hasInsertId = item.insertId != null && item.insertId > 0;
        const hasChanged = item.changed != null ? item.changed : 0;
        const warning = item.warning != null || item.warningStatus != null
          ? `，警告 ${item.warning ?? item.warningStatus}`
          : '';
        let msg = `语句 ${list.length > 1 ? `#${idx + 1} ` : ''}${typeTag}执行成功`;
        if (isSelect) msg += `，返回 ${count != null ? count : '?'} 行`;
        else {
          const parts = [];
          if (count != null) parts.push(`影响 ${count} 行`);
          if (hasInsertId) parts.push(`insertId=${item.insertId}`);
          if (hasChanged > 0) parts.push(`changed=${hasChanged}`);
          if (parts.length) msg += '，' + parts.join(' / ');
        }
        msg += warning;
        pushLog(true, msg);
      } else {
        pushLog(true, `执行成功：${JSON.stringify(item)}`);
      }
    });
    ElMessage.success('执行成功');
    // emit done 让父组件刷新树；若能识别出新建的表名，也传过去
    emit('done', { sql, table: createdTable, results: list });
  } catch (e) {
    pushLog(false, e.message || String(e));
    ElMessage.error('执行失败：' + (e.message || e));
  } finally {
    executing.value = false;
    nextTick(() => cmInstance && cmInstance.refresh());
  }
}
</script>

<style scoped>
.create-editor-wrapper {
  border: 1px solid #e5e6eb;
  border-radius: 4px;
  overflow: hidden;
  background: #fff;
}
.create-editor-wrapper :deep(.CodeMirror) {
  height: 360px;
  width: 100%;
  font-size: 13px;
  line-height: 1.6;
}
.create-editor-textarea { display: none; }

.log-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  margin-bottom: 4px;
}
.log-item.log-ok { background: #e8f7ee; color: #007d3d; }
.log-item.log-err { background: #ffece8; color: #d54941; }
.log-time { opacity: 0.75; }
.log-tag {
  padding: 0 6px;
  border-radius: 2px;
  font-weight: 600;
  background: rgba(0,0,0,0.05);
}
.log-msg { flex: 1; word-break: break-all; }

.conn-dialog-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
