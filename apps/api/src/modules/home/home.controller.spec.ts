import { ForbiddenException } from '@nestjs/common';
import { HomeController } from './home.controller';

describe('HomeController', () => {
  function makeController(summary = { usual: null, recent: [] }) {
    const service = { getHomeSummary: jest.fn().mockResolvedValue(summary) };
    return { controller: new HomeController(service as any), service };
  }

  it('delegates to the service with the customer id from the JWT', async () => {
    const { controller, service } = makeController({ usual: null, recent: [] });
    const out = await controller.summary({ user: { sub: 'cust-9', type: 'customer' } } as any, {} as any);
    expect(service.getHomeSummary).toHaveBeenCalledWith('cust-9', undefined);
    expect(out).toEqual({ usual: null, recent: [] });
  });

  it('forwards the optional locationId query param to the service', async () => {
    const { controller, service } = makeController({ usual: null, recent: [] });
    await controller.summary(
      { user: { sub: 'cust-9', type: 'customer' } } as any,
      { locationId: 'loc-1' } as any,
    );
    expect(service.getHomeSummary).toHaveBeenCalledWith('cust-9', 'loc-1');
  });

  it('rejects a staff token with 403', async () => {
    const { controller } = makeController();
    await expect(
      controller.summary({ user: { sub: 'staff-1', type: 'staff', role: 'OWNER' } } as any, {} as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a missing user with 403', async () => {
    const { controller } = makeController();
    await expect(controller.summary({} as any, {} as any)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
