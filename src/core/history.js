export const HISTORY_KEY = 'migrationHistory';
export const HISTORY_MAX_ENTRIES = 10;
export const HISTORY_MAX_BYTES = 6 * 1024 * 1024;

export function historyBytes(value) {
  const text = JSON.stringify(value);
  return Math.max(text.length * 2, new TextEncoder().encode(text).length);
}

export class SessionHistory {
  constructor(storage, { maxEntries = HISTORY_MAX_ENTRIES, maxBytes = HISTORY_MAX_BYTES } = {}) {
    this.storage = storage; this.maxEntries = maxEntries; this.maxBytes = maxBytes;
  }
  async records() { return (await this.storage.get(HISTORY_KEY))[HISTORY_KEY] || []; }
  async save(records) {
    try { await this.storage.set({ [HISTORY_KEY]: records }); }
    catch { throw new Error('HISTORY_QUOTA: 无法保存撤销快照，请检查会话内存或历史记录。'); }
  }
  async add(record) {
    if (historyBytes([record]) > this.maxBytes) throw new Error('HISTORY_QUOTA: 目标备份超过会话内存上限，本次迁移未开始。请减少所选数据。');
    const records = [...await this.records(), record];
    while (records.length > this.maxEntries || historyBytes(records) > this.maxBytes) records.shift();
    await this.save(records); return record;
  }
  async get(id) {
    const record = (await this.records()).find(item => item.id === id);
    if (!record) throw new Error('HISTORY_NOT_FOUND: 历史记录已清理或浏览器会话已结束。');
    return record;
  }
  async update(id, patch) {
    const records = await this.records(), record = records.find(item => item.id === id);
    if (!record) throw new Error('HISTORY_NOT_FOUND: 撤销快照已失效。');
    Object.assign(record, patch); await this.save(records); return record;
  }
  async list() {
    const records = await this.records();
    const latest = records.findLast(record => record.undoStatus !== 'undone' && record.touched?.length);
    return records.slice().reverse().map(record => ({
      id: record.id, createdAt: record.createdAt, finishedAt: record.finishedAt, source: record.source,
      target: record.target.origin, targetTabId: record.target.tabId, types: record.types,
      status: record.status, undoStatus: record.undoStatus, undoError: record.undoError,
      undoAt: record.undoAt, count: record.count || 0,
      canUndo: latest?.id === record.id && record.status !== 'running' && record.undoStatus !== 'undoing'
    }));
  }
  async latest(id) {
    const record = await this.get(id);
    if (!(await this.list()).find(item => item.id === id)?.canUndo) throw new Error('UNDO_ORDER_REQUIRED: 请先撤销最近一条有修改的记录，再按时间倒序撤销。');
    return record;
  }
  async clear() { await this.storage.remove(HISTORY_KEY); }
}
