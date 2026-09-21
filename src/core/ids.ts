import type { Defect, DefectType, Id, RepairPlan } from "./types.js";

/** Small deterministic 32-bit FNV-1a hash -> hex. */
export function hashStrings(parts: (string | number)[]): string {
  let h = 0x811c9dc5;
  const s = parts.join(" ");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function defectId(type: DefectType, keys: (string | number)[]): Id {
  return `def_${type}_${hashStrings([type, ...keys])}`;
}

export function planId(defectId: Id, kind: RepairPlan["kind"], variant: string): Id {
  return `plan_${kind}_${hashStrings([defectId, kind, variant])}`;
}

export function lockId(kind: string, keys: (string | number)[]): Id {
  return `lock_${kind}_${hashStrings([kind, ...keys])}`;
}

export function sortDefects(defects: Defect[]): Defect[] {
  return [...defects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
