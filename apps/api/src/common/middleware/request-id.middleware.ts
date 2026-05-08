import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const HEADER = 'X-Request-ID';

// Defensive: if a client sends a hostile X-Request-ID (megabytes of data, control
// chars, etc.) we should NOT echo it back unchecked. Accept only sensible values.
const VALID = /^[A-Za-z0-9_.+/=:-]{1,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(HEADER);
    const id = incoming && VALID.test(incoming) ? incoming : randomUUID();

    req.requestId = id;
    res.setHeader(HEADER, id);

    next();
  }
}
