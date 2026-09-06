import { computed, ref } from 'vue';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import en from 'element-plus/es/locale/lang/en';
import zhCN from './zh-CN';
import enUS from './en-US';

const STORAGE_KEY = 'navcove.locale';
const messages = { 'zh-CN': zhCN, 'en-US': enUS };
const elLocales = { 'zh-CN': zhCn, 'en-US': en };

function readSaved() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && messages[saved]) return saved;
  } catch (e) {}
  return 'zh-CN';
}

export const locale = ref(readSaved());

export function setLocale(lang) {
  if (!messages[lang]) return;
  locale.value = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
}

function lookup(dict, path) {
  return path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), dict);
}

export function t(key, params) {
  const dict = messages[locale.value] || messages['zh-CN'];
  let text = lookup(dict, key);
  if (text == null) text = lookup(messages['zh-CN'], key);
  if (text == null) text = key;
  if (params && typeof text === 'string') {
    text = text.replace(/\{(\w+)\}/g, (_, name) => (params[name] == null ? '' : String(params[name])));
  }
  return text;
}

export const elLocale = computed(() => elLocales[locale.value] || zhCn);

export function useI18n() {
  return { locale, setLocale, t, elLocale };
}
