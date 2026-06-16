-- Subscription skeleton: a per-user entitlement flag. Set true when the user has an active
-- Planfect Pro subscription (wired to StoreKit / RevenueCat later). Enforcement is gated behind
-- the BILLING_ENFORCED Edge Function secret, so this stays dormant until launch.
alter table profiles add column if not exists is_pro boolean not null default false;
