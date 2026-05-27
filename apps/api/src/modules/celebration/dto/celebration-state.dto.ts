import { CelebrationState } from '../celebration-date';

/**
 * A reward live for redemption RIGHT NOW, mapped from the generic `offers`
 * table. Deliberately NOT birthday-specific — anniversary/referral reward
 * types flow through unchanged. Staff-safe: carries no customer PII.
 */
export class ActiveRewardDto {
  constructor(
    readonly reward_id: string,
    readonly type: string,
    readonly title: string,
    readonly requires_purchase: boolean,
    readonly expires_at: string | null,
  ) {}
}

/**
 * The ENTIRE staff-facing payload. Contains a derived state, a pre-localized
 * label, and any live rewards — and NOTHING else.
 *
 * Privacy contract (the reason this class exists): the customer's date of
 * birth / age / birth year are STRUCTURALLY ABSENT. This is a plain class with
 * exactly three constructor-assigned fields; JSON serialization emits only
 * those three keys. The Customer entity is never spread into it. A build-
 * failing key-absence test (added in a later task) pins this invariant.
 *
 * Note: we intentionally do NOT use class-transformer @Exclude/@Expose — no
 * global ClassSerializerInterceptor is registered, so those decorators would
 * be inert dead code. The structural guarantee above is the real defense.
 */
export class CelebrationStateDto {
  constructor(
    readonly state: CelebrationState,
    readonly label: string,
    readonly active_rewards: ActiveRewardDto[],
  ) {}
}
