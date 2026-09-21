// PLY 标量类型的确定性读写（ASCII 与两种字节序）
import { canonicalNumber } from './math3d.js';

export type ScalarType =
  | 'char' | 'int8'
  | 'uchar' | 'uint8'
  | 'short' | 'int16'
  | 'ushort' | 'uint16'
  | 'int' | 'int32'
  | 'uint' | 'uint32'
  | 'float' | 'float32'
  | 'double' | 'float64';

const SIZES: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8
};

export function typeSize(t: string): number {
  const s = SIZES[t];
  if (s === undefined) throw new Error(`不支持的 PLY 标量类型: ${t}`);
  return s;
}

export function isFloatType(t: string): boolean {
  return t === 'float' || t === 'float32' || t === 'double' || t === 'float64';
}

export function readScalar(dv: DataView, offset: number, t: string, le: boolean): number {
  switch (t) {
    case 'char': case 'int8': return dv.getInt8(offset);
    case 'uchar': case 'uint8': return dv.getUint8(offset);
    case 'short': case 'int16': return dv.getInt16(offset, le);
    case 'ushort': case 'uint16': return dv.getUint16(offset, le);
    case 'int': case 'int32': return dv.getInt32(offset, le);
    case 'uint': case 'uint32': return dv.getUint32(offset, le);
    case 'float': case 'float32': return dv.getFloat32(offset, le);
    case 'double': case 'float64': return dv.getFloat64(offset, le);
    default: throw new Error(`不支持的 PLY 标量类型: ${t}`);
  }
}

export function writeScalar(dv: DataView, offset: number, t: string, value: number, le: boolean): void {
  switch (t) {
    case 'char': case 'int8': dv.setInt8(offset, value); break;
    case 'uchar': case 'uint8': dv.setUint8(offset, value); break;
    case 'short': case 'int16': dv.setInt16(offset, value, le); break;
    case 'ushort': case 'uint16': dv.setUint16(offset, value, le); break;
    case 'int': case 'int32': dv.setInt32(offset, value, le); break;
    case 'uint': case 'uint32': dv.setUint32(offset, value, le); break;
    case 'float': case 'float32': dv.setFloat32(offset, Math.fround(value), le); break;
    case 'double': case 'float64': dv.setFloat64(offset, value, le); break;
    default: throw new Error(`不支持的 PLY 标量类型: ${t}`);
  }
}

/** 新增元素缺失属性时使用类型确定的零值 */
export function zeroValue(t: string): number {
  return 0;
}

/** ASCII 下规范序列化（与读入精度匹配的确定性最短表示） */
export function formatAsciiScalar(t: string, value: number): string {
  if (isFloatType(t)) {
    const v = t === 'float' || t === 'float32' ? Math.fround(value) : value;
    return canonicalNumber(v);
  }
  return String(Math.trunc(value));
}

export function recordBinarySize(
  scalarProps: { type: string }[],
  listProps: { countType: string; itemType: string; items: number[] }[]
): number {
  let n = 0;
  for (const p of scalarProps) n += typeSize(p.type);
  for (const p of listProps) n += typeSize(p.countType) + p.items.length * typeSize(p.itemType);
  return n;
}
