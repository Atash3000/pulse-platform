import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  CategoryDisplayStyle,
  Inventory,
  MenuCategory,
  MenuItem,
  Modifier,
  ModifierGroup,
  Temperature,
} from '../../database/entities';
import { MenuCache } from './menu.cache';
import { MenuService } from './menu.service';

const LOC = '00000000-0000-0000-0000-000000000111';

const category = (overrides: Partial<MenuCategory> = {}): MenuCategory =>
  ({
    id: overrides.id ?? 'cat-matcha',
    location_id: LOC,
    name: overrides.name ?? 'Matcha',
    sort_order: overrides.sort_order ?? 0,
    active: true,
    display_style: overrides.display_style ?? CategoryDisplayStyle.SPOTLIGHT,
  }) as unknown as MenuCategory;

const item = (overrides: Partial<MenuItem> = {}): MenuItem =>
  ({
    id: overrides.id ?? 'item-strawberry',
    category_id: overrides.category_id ?? 'cat-matcha',
    name: overrides.name ?? 'Strawberry Matcha',
    description: overrides.description ?? null,
    base_price_cents: overrides.base_price_cents ?? 645,
    image_url: null,
    active: true,
    temperature: overrides.temperature ?? Temperature.ICED,
    featured: overrides.featured ?? true,
    art_token: overrides.art_token ?? 'strawberry-matcha',
  }) as unknown as MenuItem;

// Convenience: a query-builder mock that returns a fixed list for getMany().
function qb(result: unknown[]) {
  const builder: Record<string, unknown> = {};
  ['where', 'andWhere', 'orderBy'].forEach((m) => {
    builder[m] = jest.fn().mockReturnValue(builder);
  });
  builder.getMany = jest.fn().mockResolvedValue(result);
  return builder;
}

describe('MenuService — v4 presentation fields', () => {
  let service: MenuService;
  let cache: { getFullMenu: jest.Mock; setFullMenu: jest.Mock; getItem: jest.Mock; setItem: jest.Mock };

  beforeEach(async () => {
    cache = {
      getFullMenu: jest.fn().mockResolvedValue(null),
      setFullMenu: jest.fn().mockResolvedValue(undefined),
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MenuService,
        { provide: MenuCache, useValue: cache },
        {
          provide: getRepositoryToken(MenuCategory),
          useValue: { find: jest.fn().mockResolvedValue([category()]) },
        },
        {
          provide: getRepositoryToken(MenuItem),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue(qb([item()])),
            findOne: jest.fn().mockResolvedValue({ ...item(), category: category() }),
          },
        },
        {
          provide: getRepositoryToken(ModifierGroup),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(qb([])), find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(Modifier),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(qb([])) },
        },
        {
          provide: getRepositoryToken(Inventory),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue(qb([])),
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(MenuService);
  });

  it('getFullMenu() exposes display_style on each category', async () => {
    const menu = await service.getFullMenu(LOC);
    expect(menu.categories).toHaveLength(1);
    expect(menu.categories[0].display_style).toBe('spotlight');
  });

  it('getFullMenu() exposes temperature / featured / art_token on each item', async () => {
    const menu = await service.getFullMenu(LOC);
    const it = menu.categories[0].items[0];
    expect(it.temperature).toBe('iced');
    expect(it.featured).toBe(true);
    expect(it.art_token).toBe('strawberry-matcha');
  });

  it('getItemById() returns temperature / featured / art_token', async () => {
    const payload = await service.getItemById('item-strawberry');
    expect(payload.temperature).toBe('iced');
    expect(payload.featured).toBe(true);
    expect(payload.art_token).toBe('strawberry-matcha');
  });
});
