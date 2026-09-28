import type { RequestHandler } from 'express';
import { sendData } from '../http/respond.js';

/** GET /api/auth/me: the server-resolved identity and grants. No token, claims or keys are returned. */
export const me: RequestHandler = (req, res) => {
  const auth = req.auth!; // guaranteed by policy.authenticated()
  sendData(res, {
    user: { id: auth.userId, email: auth.email, fullName: auth.fullName },
    organization: auth.organization,
    primaryFacilityId: auth.primaryFacilityId,
    roles: auth.grants.map((grant) => ({
      role: grant.role,
      scope: grant.scope,
      organizationId: grant.organizationId,
      facilityId: grant.facilityId,
    })),
    facilities: auth.facilities,
  });
};
