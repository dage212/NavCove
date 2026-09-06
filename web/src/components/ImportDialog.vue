<template>
  <el-dialog
    :model-value="visible"
    @update:model-value="$emit('update:visible', $event)"
    :title="t('import.title')"
    width="620px"
    :close-on-click-modal="false"
    :before-close="onBeforeClose"
  >
    <div style="margin-bottom:12px;color:#5e6c84;font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span>{{ t('import.targetDb') }}<el-tag size="small">{{ database }}</el-tag></span>
      <span>{{ t('import.targetTable') }}
        <el-tag v-if="table && !tables.length" size="small">{{ table }}</el-tag>
        <el-select v-else v-model="selectedTable" size="small" :placeholder="t('import.pickTable')" style="width:160px">
          <el-option v-for="t in tables" :key="t" :label="t" :value="t" />
        </el-select>
      </span>
    </div>

    <!-- 选文件 -->
    <div v-if="!file && !uploading && !merging">
      <el-upload
        drag
        :auto-upload="false"
        :show-file-list="false"
        accept=".csv"
        :on-change="onFileChange"
      >
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">{{ t('import.dropHint') }}<em>{{ t('import.clickSelect') }}</em></div>
        <template #tip>
          <div class="el-upload__tip">
            {{ t('import.tip', { size: humanSize(CHUNK_SIZE) }) }}
          </div>
        </template>
      </el-upload>
    </div>

    <!-- 文件信息 + 进度 + 控制 -->
    <div v-if="file" style="margin-top:8px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <el-icon><Document /></el-icon>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          {{ file.name }}
        </span>
        <span style="color:#86909c;font-size:12px;">{{ humanSize(file.size) }}</span>
        <el-button text size="small" @click="resetFile" :disabled="uploading || merging">{{ t('import.remove') }}</el-button>
      </div>

      <!-- 切片进度 -->
      <div style="margin-bottom:8px;">
        <div style="font-size:12px;color:#86909c;display:flex;justify-content:space-between;margin-bottom:4px;">
          <span>{{ t('import.chunkProgress') }}</span>
          <span>{{ t('import.chunks', { done: chunkDone, total: totalChunks }) }} &nbsp;|&nbsp; {{ percent }}%</span>
        </div>
        <el-progress
          :percentage="percent"
          :status="uploadError ? 'exception' : chunkDone === totalChunks ? 'success' : undefined"
          :stroke-width="10"
        />
      </div>

      <!-- 合并 + 导入进度 -->
      <div style="margin-bottom:8px;" v-if="merging">
        <div style="font-size:12px;color:#86909c;display:flex;justify-content:space-between;margin-bottom:4px;">
          <span>{{ mergingPhase }}</span>
          <span>{{ t('import.processing') }}</span>
        </div>
        <el-progress :percentage="99" :status="'warning'" :indeterminate="true" :stroke-width="8" />
      </div>

      <div v-if="lastError" style="color:#f53f3f;font-size:12px;margin-bottom:8px;">
        {{ t('import.error', { message: lastError }) }}
      </div>
    </div>

    <el-form style="margin-top:14px" label-width="100px">
      <el-form-item :label="t('import.mode')">
        <el-radio-group v-model="mode">
          <el-radio value="insert">{{ t('import.insert') }}</el-radio>
          <el-radio value="replace">{{ t('import.replace') }}</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="t('import.concurrency')">
        <el-slider
          v-model="concurrency"
          :min="1"
          :max="8"
          :step="1"
          :show-stops="true"
          style="max-width:260px;display:inline-block;"
        />
        <span style="color:#86909c;margin-left:12px;font-size:12px;">{{ t('import.concurrencyHint', { n: concurrency }) }}</span>
      </el-form-item>
      <el-form-item :label="t('import.resume')">
        <el-tooltip :content="t('import.resumeTip')">
          <el-switch v-model="resumeEnabled" />
        </el-tooltip>
        <div style="color:#86909c;font-size:12px;margin-top:4px;">
          <span v-if="uploadId">{{ t('import.uploadId') }}<code>{{ uploadId }}</code></span>
          <span v-else>{{ t('import.autoTask') }}</span>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <div class="conn-dialog-footer">
        <el-button @click="$emit('update:visible', false)" :disabled="uploading || merging">{{ t('common.cancel') }}</el-button>
        <el-button
          v-if="file"
          @click="startOrResumeUpload"
          :loading="uploading"
          :disabled="!targetTable || merging"
          type="primary"
        >
          {{ chunkDone > 0 && chunkDone < totalChunks ? t('import.continue') : t('import.start') }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, watch, computed, onBeforeUnmount } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';
import { t } from '../i18n';

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB 一片

const props = defineProps({
  visible: Boolean,
  conn: Object,
  database: String,
  table: String,
  tables: { type: Array, default: () => [] }
});
const emit = defineEmits(['update:visible', 'done']);

const file = ref(null);
const fileName = ref('');
const mode = ref('insert');
const selectedTable = ref('');
const concurrency = ref(3);
const resumeEnabled = ref(true);

// 上传/合并状态
const uploadId = ref('');
const totalChunks = ref(0);
const chunkDone = ref(0);          // 已完成切片数（已写入磁盘确认）
const doneSet = ref(new Set());    // 已完成切片 index
const uploading = ref(false);
const merging = ref(false);
const mergingPhase = ref('');
const lastError = ref('');

let aborted = false;

const targetTable = computed(() => (props.table && !props.tables.length ? props.table : selectedTable.value));
const percent = computed(() => {
  if (!totalChunks.value) return 0;
  return Math.round((chunkDone.value / totalChunks.value) * 100);
});

function humanSize(n) {
  if (n == null) return '-';
  const s = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < s.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 && i ? 1 : 0) + s[i];
}

watch(() => props.visible, (v) => {
  if (v) {
    resetFile(true);
    mode.value = 'insert';
    selectedTable.value = props.tables[0] || '';
  }
});

onBeforeUnmount(() => {
  aborted = true;
});

function onFileChange(f) {
  const raw = f.raw;
  if (!raw) return;
  if (!/\.csv$/i.test(raw.name)) {
    ElMessage.warning(t('import.csvOnly'));
    return;
  }
  file.value = raw;
  fileName.value = raw.name;
  totalChunks.value = Math.max(1, Math.ceil(raw.size / CHUNK_SIZE));
  chunkDone.value = 0;
  doneSet.value = new Set();
  uploadId.value = '';
  lastError.value = '';
}

function resetFile(silent) {
  file.value = null;
  fileName.value = '';
  uploadId.value = '';
  totalChunks.value = 0;
  chunkDone.value = 0;
  doneSet.value = new Set();
  lastError.value = '';
  uploading.value = false;
  merging.value = false;
  if (!silent) ElMessage.info(t('import.removed'));
}

async function onBeforeClose() {
  if (uploading.value || merging.value) {
    try {
      await ElMessageBox.confirm(t('import.closeConfirm'), t('common.tip'), { type: 'warning' });
    } catch (e) {
      return false;
    }
    aborted = true;
    if (uploadId.value) {
      try { await api.importCancel(uploadId.value); } catch (e) {}
    }
  }
  return true;
}

// --- 切片上传主流程（断点续传 + 并发控制 + 失败重试）---
async function startOrResumeUpload() {
  if (!targetTable.value) { ElMessage.warning(t('import.needTable')); return; }
  if (!file.value) { ElMessage.warning(t('import.needFile')); return; }
  if (!props.conn || !props.conn.id) { ElMessage.error(t('import.notConnected')); return; }

  lastError.value = '';
  aborted = false;

  try {
    // Step 1: init（断点续传：相同 file => 相同 uploadId + 返回缺失切片）
    const initData = await api.importInit({
      fileName: file.value.name,
      fileSize: file.value.size,
      chunkSize: CHUNK_SIZE,
      // 只做轻量断点续传 key，不上传真实 md5；后端 fileName+size 组合足够日常使用
      fileHash: resumeEnabled.value ? undefined : ('__NEW__' + Math.random().toString(36).slice(2))
    });
    uploadId.value = initData.uploadId;
    totalChunks.value = initData.totalChunks;

    if (initData.imported) {
      ElMessage.success(t('import.alreadyDone'));
      emit('done', { imported: initData.imported || null, database: props.database, table: targetTable.value });
      emit('update:visible', false);
      return;
    }
    if (initData.doneChunks && initData.doneChunks.length) {
      doneSet.value = new Set(initData.doneChunks);
      chunkDone.value = doneSet.value.size;
    }
    // needChunks 由后端返回缺失切片列表：空数组表示全部已上传，直接进入合并/导入流程
    const needList = (initData.needChunks || []).slice();

    if (!needList.length) {
      // 所有切片已上传，触发合并 + 导入（mergeUpload 内部对已合并的会跳过合并步骤直接重新导入）
      await doMerge();
      return;
    }

    // Step 2: 并发上传切片（含失败重试）
    uploading.value = true;
    const concur = Math.max(1, Math.min(8, Number(concurrency.value) || 3));
    let cursor = 0;
    let failFast = false;
    async function worker() {
      while (!failFast && !aborted && cursor < needList.length) {
        const idx = cursor++;
        const index = needList[idx];
        try {
          await uploadOneChunk(index, 3 /* 最多重试 3 次 */);
          doneSet.value.add(index);
          chunkDone.value = doneSet.value.size;
        } catch (e) {
          failFast = true;
          lastError.value = t('import.chunkFail', { index, message: e.message || e });
          throw e;
        }
      }
    }
    const workers = Array.from({ length: Math.min(concur, needList.length) }, () => worker());
    await Promise.all(workers);
    uploading.value = false;
    if (aborted) return;

    // Step 3: 合并切片 + 流式导入数据库
    await doMerge();
  } catch (e) {
    uploading.value = false;
    merging.value = false;
    lastError.value = lastError.value || (e.message || String(e));
    ElMessage.error(t('import.fail', { message: lastError.value }));
  }
}

async function uploadOneChunk(index, retryLeft) {
  const start = index * CHUNK_SIZE;
  const end = Math.min(file.value.size, start + CHUNK_SIZE);
  const blob = file.value.slice(start, end);
  const fd = new FormData();
  fd.append('uploadId', uploadId.value);
  fd.append('index', String(index));
  fd.append('file', blob, `chunk_${index}`);
  try {
    await api.importChunk(fd);
  } catch (e) {
    if (retryLeft > 0) {
      // 指数退避
      await new Promise((r) => setTimeout(r, 400 * (3 - retryLeft + 1)));
      return uploadOneChunk(index, retryLeft - 1);
    }
    throw e;
  }
}

async function doMerge() {
  merging.value = true;
  mergingPhase.value = t('import.merging');
  try {
    const merged = await api.importMerge({
      uploadId: uploadId.value,
      connId: props.conn.id,
      database: props.database,
      table: targetTable.value,
      replace: mode.value === 'replace',
      batchSize: 500
    });
    merging.value = false;
    const imported = merged.imported || { inserted: 0, count: 0, columns: [] };
    const skipped = (imported.badRows && imported.badRows.length) || 0;
    ElMessage.success(
      skipped
        ? t('import.doneSkipped', { count: imported.count, inserted: imported.inserted, skipped })
        : t('import.done', { count: imported.count, inserted: imported.inserted })
    );
    emit('done', { imported, database: props.database, table: targetTable.value });
    emit('update:visible', false);
    resetFile(true);
  } catch (e) {
    merging.value = false;
    lastError.value = e.message || String(e);
    ElMessage.error(t('import.failKeep', { message: lastError.value }));
  }
}
</script>
