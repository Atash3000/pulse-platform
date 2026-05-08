import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

export interface StaffContext {
  staff_user_id: string;
  location_id: string;
  role: string;
}

/**
 * All admin endpoints take their location scope from the staff JWT, NOT from
 * a query/body parameter. This is the multi-tenant guard — a staff user can
 * never see or modify orders from a different location, even if they manipulate
 * their own request.
 *
 * Throws ForbiddenException if the JWT subject isn't a staff user with both a
 * role and a location_id. RolesGuard has already enforced the minimum role
 * level by the time this runs.
 */
export function requireStaff(req: Request): StaffContext {
  const u = req.user;
  if (!u || u.type !== 'staff' || !u.sub || !u.role || !u.location_id) {
    throw new ForbiddenException('Staff credentials with location scope required');
  }
  return {
    staff_user_id: u.sub,
    location_id: u.location_id,
    role: u.role,
  };
}
