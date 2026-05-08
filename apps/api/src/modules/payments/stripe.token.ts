// DI token for the singleton Stripe client. Lives in its own file so any
// module (CheckoutModule, RefundsModule) can import it without depending on
// the full PaymentsModule.
export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

// Same idea for the webhook secret, so the webhook controller can inject it
// without reading process.env directly.
export const STRIPE_WEBHOOK_SECRET = Symbol('STRIPE_WEBHOOK_SECRET');
