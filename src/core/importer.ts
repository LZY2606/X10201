// 统一导入入口：按扩展名/magic 识别 OBJ / PLY
import type { MeshDocument } from './types.js';
import { parseOBJ } from './obj-parser.js';
import { parsePLY } from './ply-parser.js';

export function importMesh(filename: string, bytes: Uint8Array): MeshDocument {
  const magic = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 32)));
  if (magic.trimStart().startsWith('ply') && /\b(format|element)\b/.test(magic)) {
    return parsePLY(bytes, filename);
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith('.ply') && magic.trimStart().startsWith('ply')) {
    return parsePLY(bytes, filename);
  }
  if (lower.endsWith('.ply')) {
    return parsePLY(bytes, filename);
  }
  return parseOBJ(bytes, filename);
}

import { writeOBJ } from './obj-writer.js';
import { writePLY as writePLYBytes } from './ply-parser.js';

export function exportMesh(doc: MeshDocument): { bytes: Uint8Array; mime: string; ext: string } {
  if (doc.format === 'ply') {
    return { bytes: writePLYBytes(doc), mime: 'application/octet-stream', ext: 'ply' };
  }
  return { bytes: writeOBJ(doc), mime: 'text/plain', ext: 'obj' };
}
