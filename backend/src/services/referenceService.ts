import type { Database } from '../db/client.js';
import { referenceRepository } from '../repositories/referenceRepository.js';

export interface BloodGroupDto {
  id: number;
  code: string;
  displayName: string;
  abo: string | null;
  rhd: string | null;
  isKnown: boolean;
  sortOrder: number;
}

export interface ComponentDto {
  id: number;
  code: string;
  name: string;
  category: string;
  active: boolean;
}

export function createReferenceService(db: Database) {
  return {
    async listBloodGroups(): Promise<BloodGroupDto[]> {
      const rows = await referenceRepository.bloodGroups(db.prisma);
      return rows.map((row) => ({
        id: row.id,
        code: row.code,
        displayName: row.display_name,
        abo: row.abo,
        rhd: row.rhd,
        isKnown: row.is_known,
        sortOrder: row.sort_order,
      }));
    },
    async listComponents(): Promise<ComponentDto[]> {
      const rows = await referenceRepository.components(db.prisma);
      return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, category: row.category, active: row.active }));
    },
  };
}

export type ReferenceService = ReturnType<typeof createReferenceService>;
