/** Pedigree tree from sire/dam links — pure. */

export interface PedigreeAnimal {
  id: string;
  name: string;
  sex?: string | null;
  breed?: string | null;
  registration_no?: string | null;
  sire_id?: string | null;
  dam_id?: string | null;
}

export interface PedigreeNode {
  id: string;
  name: string;
  sex: string | null;
  breed: string | null;
  registrationNo: string | null;
  sire: PedigreeNode | null;
  dam: PedigreeNode | null;
}

export function buildPedigree(
  rootId: string,
  byId: Map<string, PedigreeAnimal>,
  generations: number,
  seen: Set<string> = new Set(),
): PedigreeNode | null {
  const a = byId.get(rootId);
  if (!a || seen.has(rootId)) return null; // guard against a cycle in the data
  seen.add(rootId);

  const node: PedigreeNode = {
    id: a.id,
    name: a.name,
    sex: a.sex ?? null,
    breed: a.breed ?? null,
    registrationNo: a.registration_no ?? null,
    sire: null,
    dam: null,
  };
  if (generations > 0) {
    node.sire = a.sire_id ? buildPedigree(a.sire_id, byId, generations - 1, new Set(seen)) : null;
    node.dam = a.dam_id ? buildPedigree(a.dam_id, byId, generations - 1, new Set(seen)) : null;
  }
  return node;
}
