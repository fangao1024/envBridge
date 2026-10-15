export const TYPES = ['cookies', 'localStorage', 'sessionStorage', 'indexedDB'];
export const LABELS = { cookies: 'Cookies', localStorage: 'localStorage', sessionStorage: 'sessionStorage', indexedDB: 'IndexedDB' };
export const DEFAULTS = { cookieMode: 'rewrite', storageMode: 'merge', indexedDBMode: 'merge', reload: false, preview: true };
export const BATCH_SIZE = 500;
export const LARGE_RECORD_COUNT = 100000;
export const LARGE_BYTES = 100 * 1024 * 1024;
