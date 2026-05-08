import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { StaffRole } from '../../database/entities';
import { AuthenticatedRequestUser } from './jwt-payload';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<StaffRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @Roles() on this route → guard does not gate it. (AuthGuard('jwt')
    // still authenticates the request; this guard only enforces role membership.)
    if (!required || required.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedRequestUser }>();
    const user = req.user;

    if (!user || user.type !== 'staff' || !user.role) {
      throw new ForbiddenException('Staff credentials required');
    }

    if (!required.includes(user.role)) {
      throw new ForbiddenException(`Requires one of: ${required.join(', ')}`);
    }

    return true;
  }
}
