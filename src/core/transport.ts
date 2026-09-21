// 文档序列化（浏览器端）：剥离 Map 后 JSON 化，originalBytes 走 base64。
import type { MeshDocument } from './types.js';

interface SerializedDoc {
  doc: Omit<MeshDocument, 'vertexMap' | 'uvMap' | 'normalMap' | 'faceMap' | 'originalBytes'>;
  originalBytesBase64: string | null;
}

export function serializeDoc(doc: MeshDocument): string {
  const { vertexMap, uvMap, normalMap, faceMap, originalBytes, ...rest } = doc;
  void vertexMap; void uvMap; void normalMap; void faceMap;
  const payload: SerializedDoc = {
    doc: rest,
    originalBytesBase64: originalBytes ? bytesToBase64(originalBytes) : null
  };
  return JSON.stringify(payload);
}

export function deserializeDoc(text: string): MeshDocument {
  const payload = JSON.parse(text) as SerializedDoc;
  const doc = payload.doc as unknown as MeshDocument;
  doc.vertexMap = new Map(doc.vertices.map((v) => [v.id, v]));
  doc.uvMap = new Map(doc.uvs.map((v) => [v.id, v]));
  doc.normalMap = new Map(doc.normals.map((v) => [v.id, v]));
  doc.faceMap = new Map(doc.faces.map((v) => [v.id, v]));
  doc.originalBytes = payload.originalBytesBase64
    ? base64ToBytes(payload.originalBytesBase64)
    : undefined;
  return doc;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
