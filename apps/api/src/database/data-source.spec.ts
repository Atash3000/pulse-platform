describe('data-source pool sizing', () => {
  let ORIGINAL: string | undefined;
  beforeEach(() => {
    ORIGINAL = process.env.DATABASE_POOL_MAX;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = ORIGINAL;
    jest.resetModules();
  });

  it('defaults extra.max to 20 when DATABASE_POOL_MAX is unset', () => {
    delete process.env.DATABASE_POOL_MAX;
    jest.isolateModules(() => {
      const { dataSourceOptions } = require('./data-source');
      expect((dataSourceOptions.extra as { max: number }).max).toBe(20);
    });
  });

  it('reads extra.max from DATABASE_POOL_MAX', () => {
    process.env.DATABASE_POOL_MAX = '33';
    jest.isolateModules(() => {
      const { dataSourceOptions } = require('./data-source');
      expect((dataSourceOptions.extra as { max: number }).max).toBe(33);
    });
  });

  it('falls back to 20 for an empty-string DATABASE_POOL_MAX (not 0)', () => {
    process.env.DATABASE_POOL_MAX = '';
    jest.isolateModules(() => {
      const { dataSourceOptions } = require('./data-source');
      expect((dataSourceOptions.extra as { max: number }).max).toBe(20);
    });
  });

  it('falls back to 20 for a non-numeric DATABASE_POOL_MAX', () => {
    process.env.DATABASE_POOL_MAX = 'abc';
    jest.isolateModules(() => {
      const { dataSourceOptions } = require('./data-source');
      expect((dataSourceOptions.extra as { max: number }).max).toBe(20);
    });
  });
});
