export function storageDiff(source, target, mode = 'merge') {
  const targetMap = new Map(target.map(item => [item.key, item.value]));
  const sourceKeys = new Set(source.map(item => item.key));
  const rows = source.map(item => ({ id: item.key, name: item.key, status: !targetMap.has(item.key) ? 'add' : targetMap.get(item.key) === item.value ? 'same' : 'modify', bytes: new TextEncoder().encode(item.value).byteLength }));
  if (mode === 'clear') {
    for (const item of target) if (!sourceKeys.has(item.key)) rows.push({ id: item.key, name: item.key, status: 'remove', bytes: 0 });
  }
  return rows;
}

export function schemaConflicts(source, target) {
  if (!target) return [];
  const conflicts = [];
  for (const store of source.stores) {
    const existing = target.stores.find(item => item.name === store.name);
    if (!existing) continue;
    if (JSON.stringify(existing.keyPath) !== JSON.stringify(store.keyPath) || existing.autoIncrement !== store.autoIncrement) conflicts.push(`${store.name} 的 keyPath / autoIncrement 不兼容`);
    for (const index of store.indexes) {
      const other = existing.indexes.find(item => item.name === index.name);
      if (other && (JSON.stringify(other.keyPath) !== JSON.stringify(index.keyPath) || other.unique !== index.unique || other.multiEntry !== index.multiEntry)) conflicts.push(`${store.name}.${index.name} 索引不兼容`);
    }
  }
  return conflicts;
}
