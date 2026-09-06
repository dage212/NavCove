<template>
  <el-dialog
    :model-value="visible"
    @update:model-value="$emit('update:visible', $event)"
    :title="t('settings.title')"
    width="440px"
    :close-on-click-modal="false"
  >
    <el-form label-width="72px" class="settings-form">
      <el-form-item :label="t('settings.language')">
        <el-radio-group :model-value="locale" @change="onLangChange">
          <el-radio-button value="zh-CN">简体中文</el-radio-button>
          <el-radio-button value="en-US">English</el-radio-button>
        </el-radio-group>
        <div class="settings-hint">{{ t('settings.languageHint') }}</div>
      </el-form-item>
    </el-form>
  </el-dialog>
</template>

<script setup>
import { t, locale, setLocale } from '../i18n';

defineProps({
  visible: Boolean
});
defineEmits(['update:visible']);

function onLangChange(lang) {
  setLocale(lang);
}
</script>

<style scoped>
.settings-form { padding: 8px 4px 0; }
.settings-hint {
  margin-top: 10px;
  font-size: 12px;
  color: var(--c-text-3, #64748B);
  line-height: 1.5;
}
</style>
