import { StaffRole } from '../../database/entities';

// Subject type ('customer' or 'staff') is encoded in the token so a single
// JwtStrategy can resolve both. Customers have no role; staff carry one of
// OWNER | MANAGER | BARISTA.
export type SubjectType = 'customer' | 'staff';

export interface JwtPayload {
  sub: string;            // user id (customer.id or staff_user.id)
  type: SubjectType;
  role?: StaffRole;       // only present when type === 'staff'
  location_id?: string;   // only present when type === 'staff'
  // standard claims (exp/iat) are populated by @nestjs/jwt automatically
}

export interface AuthenticatedRequestUser extends JwtPayload {}
