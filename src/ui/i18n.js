import { EN } from './translations-en.js';

export const DEFAULT_LANGUAGE = 'zh-CN';
export const LANGUAGE_STORAGE_KEY = 'uiLanguage';
let language = DEFAULT_LANGUAGE;
export const normalizeLanguage = value => value === 'en' ? 'en' : DEFAULT_LANGUAGE;
export const getLanguage = () => language;
export function setLanguage(value) { language = normalizeLanguage(value); }
export function t(source, params = {}) {
  const template = language === 'en' ? EN[source] ?? source : source;
  return template.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(params, key) ? String(params[key]) : token);
}

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const messageTemplates = Object.keys(EN).filter(key => /\{\w+\}/.test(key)).map(source => {
  const names = [];
  const pattern = source.split(/(\{\w+\})/g).map(part => {
    if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return '(.*?)'; }
    return escapeRegex(part);
  }).join('');
  return { source, names, pattern: new RegExp(`^${pattern}$`, 's') };
});

// Apply only to application messages, never to names, URLs, keys, or website data.
export function translateMessage(message) {
  const source = String(message ?? '');
  if (language !== 'en' || !source) return source;
  if (Object.hasOwn(EN, source)) return EN[source];
  const coded = source.match(/^([A-Z_]+)[:：]\s*(.*)$/s);
  if (coded) return `${coded[1]}: ${translateMessage(coded[2])}`;
  if (source.startsWith('所选数据全部读取失败。')) {
    return t('所选数据全部读取失败。') + ' ' + source.slice('所选数据全部读取失败。'.length)
      .split(/(?<![A-Z_])(?=[A-Z_]+:)/).map(part => part.trim()).filter(Boolean).map(translateMessage).join(' ');
  }
  for (const { source: template, names, pattern } of messageTemplates) {
    const match = source.match(pattern);
    if (match) return t(template, Object.fromEntries(names.map((name, index) => [name, match[index + 1]])));
  }
  return source;
}

export function translateDocument(root = document) {
  root.documentElement.lang = language;
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const text = [...node.childNodes].find(child => child.nodeType === 3 && child.textContent.trim());
    if (text) text.textContent = t(node.dataset.i18n);
  }
  for (const attribute of ['title', 'aria-label', 'placeholder']) {
    for (const node of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}
