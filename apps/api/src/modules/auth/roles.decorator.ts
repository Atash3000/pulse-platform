import { SetMetadata } from '@nestjs/common';
import { StaffRole } from '../../database/entities';

export const ROLES_KEY = 'roles';

/**
 * Mark a controller or route as requiring one of the listed staff roles.
 *
 * Customer-only endpoints don't use this decorator at all — they only need
 * AuthGuard('jwt'). Staff endpoints use both AuthGuard('jwt') and RolesGuard,
 * with @Roles(...) declaring which staff roles are allowed.
 *
 * Examples:
 *   @Roles(StaffRole.BARISTA, StaffRole.MANAGER, StaffRole.OWNER)  // BARISTA+
 *   @Roles(StaffRole.MANAGER, StaffRole.OWNER)                     // MANAGER+
 *   @Roles(StaffRole.OWNER)                                        // OWNER only
 */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);
