import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Relation,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

// =============================================================================
// ENUMS — PostgreSQL ENUM types. Source of truth for status values across the
// entire platform. iOS, dashboard and backend MUST use these exact strings.
// =============================================================================

export enum StaffRole {
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
  BARISTA = 'BARISTA',
}

export enum OrderStatus {
  DRAFT = 'DRAFT',
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  PAID = 'PAID',
  ACCEPTED = 'ACCEPTED',
  IN_PROGRESS = 'IN_PROGRESS',
  READY = 'READY',
  PICKED_UP = 'PICKED_UP',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
  FAILED = 'FAILED',
}

export enum PaymentStatus {
  REQUIRES_PAYMENT = 'REQUIRES_PAYMENT',
  PROCESSING = 'PROCESSING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
}

export enum CloverSyncStatus {
  NOT_SENT = 'NOT_SENT',
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  MANUAL_REQUIRED = 'MANUAL_REQUIRED',
}

export enum PickupType {
  ASAP = 'ASAP',
  SCHEDULED = 'SCHEDULED',
}

export enum LoyaltyTier {
  BRONZE = 'BRONZE',
  SILVER = 'SILVER',
  GOLD = 'GOLD',
  PLATINUM = 'PLATINUM',
}

export enum OutboxEventType {
  ORDER_PAID = 'ORDER_PAID',
  /**
   * Companion to `ORDER_PAID`, emitted atomically with it in the same
   * webhook transaction. Routes to `NotificationsService` for the manager
   * "NEW ORDER" Telegram alert. Each retries independently so a transient
   * failure in the alert path doesn't cause the analytics handler
   * (`orderWorker.handleOrderPaid`) to re-run, and vice versa. See
   * decision-log entry "ORDER_PAID split-event design: analytics +
   * notification retry independently" (C5).
   */
  ORDER_PAID_NOTIFICATION = 'ORDER_PAID_NOTIFICATION',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  ORDER_READY = 'ORDER_READY',
  ORDER_PICKED_UP = 'ORDER_PICKED_UP',
  REFUND_CREATED = 'REFUND_CREATED',
  ITEM_OUT_OF_STOCK = 'ITEM_OUT_OF_STOCK',
}

export enum OutboxStatus {
  PENDING = 'PENDING',
  PROCESSED = 'PROCESSED',
  DEAD = 'DEAD',
}

export enum BehaviorEventType {
  MENU_VIEWED = 'menu_viewed',
  ITEM_VIEWED = 'item_viewed',
  CART_ADDED = 'cart_added',
  CART_REMOVED = 'cart_removed',
  OFFER_SEEN = 'offer_seen',
  OFFER_REDEEMED = 'offer_redeemed',
  APP_OPENED = 'app_opened',
}

// =============================================================================
// 3.1 LOCATION & USER TABLES
// =============================================================================

@Entity({ name: 'locations' })
export class Location {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  address!: string;

  @Column({ type: 'text', nullable: true })
  phone!: string | null;

  @Column({ type: 'text', default: 'America/New_York' })
  timezone!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @OneToMany(() => LocationHours, (h) => h.location)
  hours!: Relation<LocationHours[]>;

  @OneToOne(() => LocationSettings, (s) => s.location)
  settings!: Relation<LocationSettings>;
}

@Entity({ name: 'location_hours' })
@Index(['location_id', 'day_of_week'])
export class LocationHours {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  location_id!: string;

  @ManyToOne(() => Location, (l) => l.hours, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'location_id' })
  location!: Location;

  @Column({ type: 'int' })
  day_of_week!: number;

  @Column({ type: 'time' })
  open_time!: string;

  @Column({ type: 'time' })
  close_time!: string;

  @Column({ type: 'boolean', default: false })
  is_closed!: boolean;
}

@Entity({ name: 'location_settings' })
export class LocationSettings {
  @PrimaryColumn({ type: 'uuid' })
  location_id!: string;

  @OneToOne(() => Location, (l) => l.settings, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'location_id' })
  location!: Location;

  @Column({ type: 'boolean', default: false })
  mobile_ordering_paused!: boolean;

  @Column({ type: 'int', default: 5 })
  current_wait_minutes!: number;

  @Column({ type: 'boolean', default: true })
  scheduled_ordering!: boolean;

  @Column({ type: 'int', default: 7 })
  max_schedule_days!: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}

@Entity({ name: 'customers' })
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'text', unique: true })
  email!: string;

  @Column({ type: 'text', nullable: true })
  phone!: string | null;

  @Column({ type: 'text' })
  full_name!: string;

  @Index({ unique: true, where: 'cognito_id IS NOT NULL' })
  @Column({ type: 'text', nullable: true })
  cognito_id!: string | null;

  @Column({ type: 'text', nullable: true })
  password_hash!: string | null;

  @Column({ type: 'int', default: 0 })
  loyalty_points!: number;

  @Column({ type: 'text', default: LoyaltyTier.BRONZE })
  loyalty_tier!: string;

  @Column({ type: 'text', nullable: true })
  stripe_customer_id!: string | null;

  @Column({ type: 'text', nullable: true })
  push_token!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_visit_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}

@Entity({ name: 'staff_users' })
export class StaffUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  location_id!: string;

  @ManyToOne(() => Location, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'location_id' })
  location!: Location;

  @Index({ unique: true })
  @Column({ type: 'text', unique: true })
  email!: string;

  @Column({ type: 'text' })
  full_name!: string;

  @Column({
    type: 'enum',
    enum: StaffRole,
    enumName: 'staff_role_enum',
  })
  role!: StaffRole;

  @Column({ type: 'text' })
  password_hash!: string;

  @Index({ unique: true, where: 'cognito_id IS NOT NULL' })
  @Column({ type: 'text', nullable: true })
  cognito_id!: string | null;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}

// =============================================================================
// 3.2 MENU & INVENTORY TABLES
// =============================================================================

@Entity({ name: 'menu_categories' })
export class MenuCategory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  location_id!: string;

  @ManyToOne(() => Location, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'location_id' })
  location!: Location;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'int', default: 0 })
  sort_order!: number;

  @Column({ type: 'boolean', default: true })
  active!: boolean;
}

@Entity({ name: 'menu_items' })
export class MenuItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  category_id!: string;

  @ManyToOne(() => MenuCategory, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'category_id' })
  category!: MenuCategory;

  @Index()
  @Column({ type: 'text', nullable: true })
  clover_item_id!: string | null;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'int' })
  base_price_cents!: number;

  @Column({ type: 'text', nullable: true })
  image_url!: string | null;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @OneToMany(() => ModifierGroup, (g) => g.item)
  modifier_groups!: Relation<ModifierGroup[]>;
}

@Entity({ name: 'modifier_groups' })
export class ModifierGroup {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  item_id!: string;

  @ManyToOne(() => MenuItem, (i) => i.modifier_groups, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item!: MenuItem;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'boolean', default: false })
  required!: boolean;

  @Column({ type: 'boolean', default: false })
  multi_select!: boolean;

  @Column({ type: 'int', default: 0 })
  sort_order!: number;

  @OneToMany(() => Modifier, (m) => m.group)
  modifiers!: Relation<Modifier[]>;
}

@Entity({ name: 'modifiers' })
export class Modifier {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  group_id!: string;

  @ManyToOne(() => ModifierGroup, (g) => g.modifiers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'group_id' })
  group!: ModifierGroup;

  @Index()
  @Column({ type: 'text', nullable: true })
  clover_mod_id!: string | null;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'int', default: 0 })
  price_cents!: number;

  @Column({ type: 'int', default: 0 })
  sort_order!: number;

  @Column({ type: 'boolean', default: true })
  active!: boolean;
}

@Entity({ name: 'inventory' })
@Unique(['item_id', 'location_id'])
export class Inventory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  item_id!: string;

  @ManyToOne(() => MenuItem, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item!: MenuItem;

  @Column({ type: 'uuid' })
  location_id!: string;

  @ManyToOne(() => Location, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'location_id' })
  location!: Location;

  @Column({ type: 'boolean', default: true })
  available!: boolean;

  @Column({ type: 'int', nullable: true })
  quantity_left!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  sold_out_at!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  updated_by!: string | null;

  @ManyToOne(() => StaffUser, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'updated_by' })
  updated_by_user!: StaffUser | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}

@Entity({ name: 'pricing_rules' })
export class PricingRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  location_id!: string;

  @ManyToOne(() => Location, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'location_id' })
  location!: Location;

  @Column({ type: 'int' })
  tax_rate_bps!: number;

  @Column({ type: 'int', array: true, default: () => `'{15,18,20,25}'::int[]` })
  tip_options!: number[];

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}

// =============================================================================
// 3.3 ORDER, PAYMENT & REFUND TABLES
// =============================================================================

@Entity({ name: 'orders' })
// Explicit individual indexes (Fix 2). The outbox/admin/customer-history queries
// hit each of these columns separately, so we index them explicitly rather than
// relying on FK or composite-prefix coverage.
@Index('IDX_orders_customer_id', ['customer_id'])
@Index('IDX_orders_location_id', ['location_id'])
@Index('IDX_orders_order_status', ['order_status'])
@Index('IDX_orders_created_at', ['created_at'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  customer_id!: string;

  @ManyToOne(() => Customer, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'customer_id' })
  customer!: Customer;

  @Column({ type: 'uuid' })
  location_id!: string;

  @ManyToOne(() => Location, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'location_id' })
  location!: Location;

  @Index({ unique: true })
  @Column({ type: 'text', unique: true })
  idempotency_key!: string;

  @Column({
    type: 'enum',
    enum: OrderStatus,
    enumName: 'order_status_enum',
    default: OrderStatus.DRAFT,
  })
  order_status!: OrderStatus;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    enumName: 'payment_status_enum',
    default: PaymentStatus.REQUIRES_PAYMENT,
  })
  payment_status!: PaymentStatus;

  @Column({
    type: 'enum',
    enum: CloverSyncStatus,
    enumName: 'clover_sync_status_enum',
    default: CloverSyncStatus.NOT_SENT,
  })
  clover_sync_status!: CloverSyncStatus;

  @Column({
    type: 'enum',
    enum: PickupType,
    enumName: 'pickup_type_enum',
    default: PickupType.ASAP,
  })
  pickup_type!: PickupType;

  @Column({ type: 'timestamptz', nullable: true })
  scheduled_pickup_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  estimated_ready_at!: Date | null;

  @Column({ type: 'int' })
  subtotal_cents!: number;

  @Column({ type: 'int', default: 0 })
  modifier_cents!: number;

  @Column({ type: 'int', default: 0 })
  discount_cents!: number;

  @Column({ type: 'int' })
  tax_cents!: number;

  @Column({ type: 'int', default: 0 })
  tip_cents!: number;

  @Column({ type: 'int' })
  total_cents!: number;

  @Index()
  @Column({ type: 'text', nullable: true })
  stripe_payment_id!: string | null;

  @Index()
  @Column({ type: 'text', nullable: true })
  clover_order_id!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @OneToMany(() => OrderItem, (i) => i.order)
  items!: Relation<OrderItem[]>;
}

export interface OrderItemModifierSnapshot {
  modifierId: string;
  name: string;
  priceCents: number;
}

@Entity({ name: 'order_items' })
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  order_id!: string;

  @ManyToOne(() => Order, (o) => o.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ type: 'uuid' })
  menu_item_id!: string;

  @ManyToOne(() => MenuItem, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'menu_item_id' })
  menu_item!: MenuItem;

  /**
   * Frozen snapshot of menu_items.name at order time. Matches the snapshot
   * semantics for unit_price_cents and modifiers — historical orders show
   * what the customer actually paid for, even if the menu item is later
   * renamed or deleted.
   */
  @Column({ type: 'text' })
  item_name!: string;

  @Column({ type: 'int', default: 1 })
  quantity!: number;

  @Column({ type: 'int' })
  unit_price_cents!: number;

  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  modifiers!: OrderItemModifierSnapshot[];
}

@Entity({ name: 'order_events' })
@Index(['order_id', 'created_at'])
export class OrderEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  order_id!: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ type: 'text', nullable: true })
  from_status!: string | null;

  @Column({ type: 'text' })
  to_status!: string;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'text' })
  created_by!: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}

@Entity({ name: 'payments' })
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  order_id!: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Index({ unique: true })
  @Column({ type: 'text', unique: true })
  stripe_payment_id!: string;

  @Column({ type: 'int' })
  amount_cents!: number;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    enumName: 'payment_status_enum',
  })
  payment_status!: PaymentStatus;

  @Column({ type: 'jsonb', nullable: true })
  stripe_response!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}

@Entity({ name: 'refunds' })
export class Refund {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  order_id!: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ type: 'uuid' })
  payment_id!: string;

  @ManyToOne(() => Payment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'payment_id' })
  payment!: Payment;

  @Index({ unique: true })
  @Column({ type: 'text', unique: true })
  stripe_refund_id!: string;

  @Column({ type: 'int' })
  amount_cents!: number;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'uuid' })
  created_by!: string;

  @ManyToOne(() => StaffUser, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by' })
  created_by_user!: StaffUser;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}

@Entity({ name: 'clover_sync_log' })
@Index(['order_id', 'attempt_number'])
export class CloverSyncLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  order_id!: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ type: 'int' })
  attempt_number!: number;

  @Column({
    type: 'enum',
    enum: CloverSyncStatus,
    enumName: 'clover_sync_status_enum',
  })
  sync_status!: CloverSyncStatus;

  @Column({ type: 'jsonb', nullable: true })
  request_payload!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  response_payload!: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error_message!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'attempted_at' })
  attempted_at!: Date;
}

// =============================================================================
// 3.4 AI & BEHAVIOUR TABLES (created now, populated Phase 2)
// =============================================================================

@Entity({ name: 'customer_ai_profiles' })
export class CustomerAiProfile {
  @PrimaryColumn({ type: 'uuid' })
  customer_id!: string;

  @OneToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer!: Customer;

  @Column({ type: 'text', nullable: true })
  preferred_milk!: string | null;

  @Column({ type: 'text', nullable: true })
  preferred_size!: string | null;

  @Column({ type: 'text', nullable: true })
  preferred_temp!: string | null;

  @Column({ type: 'text', array: true, default: () => `'{}'::text[]` })
  disliked_items!: string[];

  @Column({ type: 'text', array: true, default: () => `'{}'::text[]` })
  dietary_flags!: string[];

  @Column({ type: 'text', nullable: true })
  price_segment!: string | null;

  @Column({ type: 'boolean', nullable: true })
  impulse_buyer!: boolean | null;

  @Column({ type: 'boolean', nullable: true })
  deal_responsive!: boolean | null;

  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  adventurousness!: string | null;

  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  churn_score!: string | null;

  @Column({ type: 'int', nullable: true })
  lifetime_value_cents!: number | null;

  @Column({ type: 'int', nullable: true })
  avg_order_value_cents!: number | null;

  @Column({ type: 'time', nullable: true })
  usual_order_time!: string | null;

  @Column({ type: 'int', array: true, default: () => `'{}'::int[]` })
  usual_order_days!: number[];

  @Column({ type: 'decimal', precision: 4, scale: 3, nullable: true })
  notification_open_rate!: string | null;

  @Column({ type: 'decimal', precision: 4, scale: 3, nullable: true })
  recommendation_accept_rate!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_calculated_at!: Date | null;
}

@Entity({ name: 'behavior_events' })
@Index(['customer_id', 'created_at'])
@Index(['event_type', 'created_at'])
export class BehaviorEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  customer_id!: string;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer!: Customer;

  @Column({
    type: 'enum',
    enum: BehaviorEventType,
    enumName: 'behavior_event_type_enum',
  })
  event_type!: BehaviorEventType;

  @Column({ type: 'uuid', nullable: true })
  item_id!: string | null;

  @Column({ type: 'int', nullable: true })
  duration_seconds!: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}

@Entity({ name: 'ai_decisions' })
@Index(['customer_id', 'created_at'])
export class AiDecision {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  customer_id!: string;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer!: Customer;

  @Column({ type: 'text' })
  trigger!: string;

  @Column({ type: 'text' })
  decision_type!: string;

  @Column({ type: 'uuid', nullable: true })
  recommendation_item_id!: string | null;

  @Column({ type: 'text', nullable: true })
  offer_type!: string | null;

  @Column({ type: 'int', nullable: true })
  offer_value_cents!: number | null;

  @Column({ type: 'decimal', precision: 4, scale: 3, nullable: true })
  confidence!: string | null;

  @Column({ type: 'boolean', default: false })
  was_shown!: boolean;

  @Column({ type: 'boolean', nullable: true })
  was_accepted!: boolean | null;

  @Column({ type: 'int', nullable: true })
  revenue_generated_cents!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at!: Date | null;
}

@Entity({ name: 'offers' })
@Index(['customer_id', 'sent_at'])
export class Offer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  customer_id!: string;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer!: Customer;

  @Column({ type: 'text' })
  type!: string;

  @Column({ type: 'int' })
  value_cents!: number;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sent_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  opened_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  redeemed_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at!: Date | null;

  @Column({ type: 'int', nullable: true })
  revenue_attributed_cents!: number | null;
}

// =============================================================================
// 3.5 LOYALTY, OUTBOX & FEATURE FLAGS
// =============================================================================

@Entity({ name: 'loyalty_accounts' })
export class LoyaltyAccount {
  @PrimaryColumn({ type: 'uuid' })
  customer_id!: string;

  @OneToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer!: Customer;

  @Column({ type: 'int', default: 0 })
  points_balance!: number;

  @Column({ type: 'int', default: 0 })
  lifetime_points!: number;

  @Column({ type: 'text', default: LoyaltyTier.BRONZE })
  tier!: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}

@Entity({ name: 'loyalty_transactions' })
@Index(['customer_id', 'created_at'])
export class LoyaltyTransaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  customer_id!: string;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer!: Customer;

  @Column({ type: 'uuid', nullable: true })
  order_id!: string | null;

  @ManyToOne(() => Order, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'order_id' })
  order!: Order | null;

  @Column({ type: 'int' })
  points_delta!: number;

  @Column({ type: 'text' })
  reason!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}

@Entity({ name: 'outbox_events' })
@Index(['status', 'created_at'])
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    type: 'enum',
    enum: OutboxEventType,
    enumName: 'outbox_event_type_enum',
  })
  event_type!: OutboxEventType;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({
    type: 'enum',
    enum: OutboxStatus,
    enumName: 'outbox_status_enum',
    default: OutboxStatus.PENDING,
  })
  status!: OutboxStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  /**
   * Set by the outbox worker the moment it picks up a row, BEFORE dispatch.
   * Lets us measure two latencies separately:
   *   queue latency      = processing_started_at - created_at
   *   processing latency = processed_at         - processing_started_at
   * And lets us detect stuck rows: processing_started_at IS NOT NULL AND
   * processed_at IS NULL AND status = 'PENDING' for too long means a worker
   * crashed mid-process or hung.
   *
   * Overwritten on each retry — reflects the current attempt's start time.
   */
  @Column({ type: 'timestamptz', nullable: true })
  processing_started_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  processed_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}

@Entity({ name: 'feature_flags' })
export class FeatureFlag {
  @PrimaryColumn({ type: 'text' })
  key!: string;

  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  @Column({ type: 'int', default: 0 })
  rollout_pct!: number;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}

// =============================================================================
// EXPORT ARRAY — used by data-source.ts so we don't list 25 entities by hand.
// =============================================================================

export const ALL_ENTITIES = [
  Location,
  LocationHours,
  LocationSettings,
  Customer,
  StaffUser,
  MenuCategory,
  MenuItem,
  ModifierGroup,
  Modifier,
  Inventory,
  PricingRule,
  Order,
  OrderItem,
  OrderEvent,
  Payment,
  Refund,
  CloverSyncLog,
  CustomerAiProfile,
  BehaviorEvent,
  AiDecision,
  Offer,
  LoyaltyAccount,
  LoyaltyTransaction,
  OutboxEvent,
  FeatureFlag,
];
