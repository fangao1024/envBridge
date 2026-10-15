/* Classic script shared by the isolated page adapter and the test harness.
 * IndexedDB values must never pass through JSON without a lossless envelope. */
globalThis.EnvBridgeCodec = function createCodec() {
  const toBase64 = bytes => {
    let value = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) value += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(value);
  };
  const fromBase64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0)).buffer;

  async function encode(root) {
    const nodes = [];
    const seen = new Map();
    async function visit(value) {
      if (value === undefined) return { p: 'undefined' };
      if (typeof value === 'bigint') return { p: 'bigint', v: value.toString() };
      if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return { p: 'number', v: Object.is(value, -0) ? '-0' : String(value) };
      if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return value;
      if (typeof value !== 'object') throw new Error('UNSUPPORTED_VALUE: 无法序列化此 IndexedDB 类型。');
      if (seen.has(value)) return { r: seen.get(value) };
      const id = nodes.length;
      seen.set(value, id);
      nodes.push(null);
      let node;
      if (Array.isArray(value)) node = ['Array', { length: value.length, entries: await Promise.all(Object.keys(value).map(async key => [key, await visit(value[key])])) }];
      else if (value instanceof Date) node = ['Date', Number.isNaN(value.getTime()) ? null : value.getTime()];
      else if (value instanceof RegExp) node = ['RegExp', [value.source, value.flags]];
      else if (value instanceof ArrayBuffer) node = ['ArrayBuffer', toBase64(new Uint8Array(value))];
      else if (ArrayBuffer.isView(value)) node = ['View', { name: value.constructor.name, buffer: await visit(value.buffer), offset: value.byteOffset, length: value instanceof DataView ? value.byteLength : value.length }];
      else if (typeof File !== 'undefined' && value instanceof File) node = ['File', { data: toBase64(new Uint8Array(await value.arrayBuffer())), type: value.type, name: value.name, lastModified: value.lastModified }];
      else if (value instanceof Blob) node = ['Blob', { data: toBase64(new Uint8Array(await value.arrayBuffer())), type: value.type }];
      else if (value instanceof Map) node = ['Map', await Promise.all([...value].map(async ([key, item]) => [await visit(key), await visit(item)]))];
      else if (value instanceof Set) node = ['Set', await Promise.all([...value].map(visit))];
      else if (typeof DOMException !== 'undefined' && value instanceof DOMException) node = ['DOMException', [value.message, value.name]];
      else if (value instanceof Error) node = ['Error', { name: value.name, message: value.message, stack: value.stack, cause: await visit(value.cause) }];
      else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) node = ['Object', await Promise.all(Object.keys(value).map(async key => [key, await visit(value[key])]))];
      else throw new Error('UNSUPPORTED_VALUE: 包含不支持的类型（例如 CryptoKey），已停止此数据库迁移。');
      nodes[id] = node;
      return { r: id };
    }
    return { version: 1, root: await visit(root), nodes };
  }

  function decode(wire) {
    if (wire.version !== 1 || !Array.isArray(wire.nodes)) throw new Error('INVALID_PAYLOAD: 数据格式不正确。');
    const allocated = new Map();
    const filled = new Set();
    const typed = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
    function read(token) {
      if (token === null || typeof token !== 'object') return token;
      if (token.p === 'undefined') return undefined;
      if (token.p === 'bigint') return BigInt(token.v);
      if (token.p === 'number') return token.v === '-0' ? -0 : Number(token.v);
      const id = token.r;
      const [type, data] = wire.nodes[id] || [];
      if (!allocated.has(id)) {
        let result;
        switch (type) {
          case 'Array': result = new Array(data.length); break;
          case 'Object': result = {}; break;
          case 'Date': result = new Date(data === null ? NaN : data); break;
          case 'RegExp': result = new RegExp(...data); break;
          case 'ArrayBuffer': result = fromBase64(data); break;
          case 'View': {
            const Constructor = typed[data.name];
            if (!Constructor) throw new Error('INVALID_PAYLOAD: 未知二进制类型。');
            result = new Constructor(read(data.buffer), data.offset, data.length); break;
          }
          case 'Blob': result = new Blob([fromBase64(data.data)], { type: data.type }); break;
          case 'File': result = new File([fromBase64(data.data)], data.name, { type: data.type, lastModified: data.lastModified }); break;
          case 'Map': result = new Map(); break;
          case 'Set': result = new Set(); break;
          case 'DOMException': result = new DOMException(...data); break;
          case 'Error': result = new Error(data.message); result.name = data.name; result.stack = data.stack; break;
          default: throw new Error('INVALID_PAYLOAD: 未知记录类型。');
        }
        allocated.set(id, result);
      }
      const result = allocated.get(id);
      if (!filled.has(id)) {
        filled.add(id);
        if (type === 'Array' || type === 'Object') for (const [key, item] of type === 'Array' ? data.entries : data) Object.defineProperty(result, key, { value: read(item), enumerable: true, configurable: true, writable: true });
        else if (type === 'Map') for (const [key, item] of data) result.set(read(key), read(item));
        else if (type === 'Set') for (const item of data) result.add(read(item));
        else if (type === 'Error' && data.cause?.p !== 'undefined') result.cause = read(data.cause);
      }
      return result;
    }
    return read(wire.root);
  }
  return { encode, decode };
};
