// Augment Express's Request type so:
//   - `req.requestId` is typed (populated by RequestIdMiddleware)
//   - `req.user`      is typed (populated by Passport's JwtStrategy.validate)
//
// We extend Express.User (not Request.user directly) because @types/passport
// declares `req.user: Express.User | undefined` and that's what wins. Adding
// our claims to Express.User is the supported merge path.

import type { JwtPayload } from '../../modules/auth/jwt-payload';

declare global {
  namespace Express {
    // Extends the Passport `Express.User` interface with our JWT claims.
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface User extends JwtPayload {}

    interface Request {
      /** UUID per request. Echoed back as the X-Request-ID response header. */
      requestId: string;
    }
  }
}

// Need at least one import/export so TS treats this file as a module rather
// than a script — without it the `declare global` doesn't apply.
export {};
