import 'reflect-metadata';
import { AppDataSource } from '../data-source';
import { FeatureFlag } from '../entities';

interface FlagDef {
  key: string;
  enabled: boolean;
  description: string;
}

const FLAGS: FlagDef[] = [
  { key: 'loyalty',            enabled: true,  description: 'Loyalty points and tier system' },
  { key: 'scheduled_ordering', enabled: true,  description: 'Allow future pickup scheduling' },
  { key: 'ai_recommendations', enabled: false, description: 'AI-powered home screen suggestions' },
  { key: 'dynamic_pricing',    enabled: false, description: 'Time and demand based pricing' },
  { key: 'subscriptions',      enabled: false, description: 'Monthly $29/mo coffee pass' },
  { key: 'group_ordering',     enabled: false, description: 'Shared cart / group orders' },
  { key: 'conversational_ai',  enabled: false, description: 'Chat-based order interface' },
  { key: 'predictive_preorder',enabled: false, description: 'Geofence-triggered pre-ordering' },
  { key: 'apple_watch_app',    enabled: false, description: 'Apple Watch companion app' },
  { key: 'flash_deals',        enabled: false, description: 'AI-triggered time-limited offers' },
  { key: 'bundle_suggestions', enabled: false, description: 'AI personalised bundles' },
  { key: 'web_ordering',       enabled: false, description: 'Browser-based ordering' },
];

async function run(): Promise<void> {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(FeatureFlag);

  let inserted = 0;
  let skipped = 0;

  for (const flag of FLAGS) {
    const existing = await repo.findOne({ where: { key: flag.key } });
    if (existing) {
      skipped += 1;
      continue;
    }
    await repo.insert({
      key: flag.key,
      enabled: flag.enabled,
      rollout_pct: flag.enabled ? 100 : 0,
      description: flag.description,
    });
    inserted += 1;
  }

  // eslint-disable-next-line no-console
  console.log(`feature-flags seed: inserted=${inserted} skipped=${skipped} total=${FLAGS.length}`);
  await AppDataSource.destroy();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('feature-flags seed failed:', err);
  process.exit(1);
});
