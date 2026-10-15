import { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, setLanguage, translateDocument } from './i18n.js';

const saved = await chrome.storage.local.get({ [LANGUAGE_STORAGE_KEY]: DEFAULT_LANGUAGE });
setLanguage(saved[LANGUAGE_STORAGE_KEY]);
translateDocument();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[LANGUAGE_STORAGE_KEY]) {
    setLanguage(changes[LANGUAGE_STORAGE_KEY].newValue);
    translateDocument();
  }
});
