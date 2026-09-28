import type { DbClient } from '../db/client.js';

/**
 * Reference data that the database exposes to everyone (RLS: `anon` and `authenticated` may SELECT
 * blood_groups and components). The backend reads with a privileged role, so visibility is
 * re-stated here: only public columns are selected. Component validation metadata (source
 * reference, approver id) is NOT public and is never selected.
 */
export const referenceRepository = {
  bloodGroups(db: DbClient) {
    return db.blood_groups.findMany({
      orderBy: { sort_order: 'asc' },
      select: { id: true, code: true, display_name: true, abo: true, rhd: true, is_known: true, sort_order: true },
    });
  },
  components(db: DbClient) {
    return db.components.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, code: true, name: true, category: true, active: true },
    });
  },
};
