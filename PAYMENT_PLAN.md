# Doing It — Monetisation Plan

## Context

Add a paid subscription tier to Doing It. Free users are limited to 5 sessions per day; subscribers get unlimited sessions. Price: $1.49/month (USD). Payment processor: Stripe. Owner is a Brazilian company selling globally.

---

## Pricing & Currency

**Charge in USD, global audience.**

- Price: **$1.49 / month**
- Stripe fee: ~$0.34 (2.9% + $0.30) → ~$1.15 net per subscriber (~23% fee rate)
- No annual plan for now — keeps obligations short if the product pivots or shuts down
- **30-day free trial** for new subscribers, handled natively by Stripe (`trial_period_days=30`). No custom logic needed.

---

## Payment Methods

Credit/debit card only (Visa, Mastercard, Amex). Handled globally via Stripe Billing.

---

## Nota Fiscal (Brazilian Tax Compliance)

Brazilian law requires issuing a **NFS-e** (nota fiscal de serviço eletrônico) for each paid service transaction. Stripe does NOT handle this.

Options:
1. **Low volume (< ~50 customers):** issue manually through your city's prefeitura portal (most have a free web interface).
2. **Automated:** integrate a service like [Enotas](https://enotas.com.br), [NFe.io](https://nfe.io), or [Omie](https://omie.com.br). They expose a REST API you call from the Stripe webhook handler after a successful payment.
3. **Accounting software:** Conta Azul or similar, which has Stripe integration and handles NF automatically.

**Recommendation:** start manually, automate once you pass ~30 paying customers.

---

## Free Tier Enforcement

- **5 sessions per day** for free users. A session is counted on start (pressing Enter to begin). The wall triggers on the 6th attempt — the user sees 5 completed sessions before hitting it, which is what the UI communicates as the limit.
- Enforcement is **server-side only** (never trust the client)
- On session start, the backend checks today's session count for the user
- If count ≥ 5 and user is not subscribed → return HTTP 402 ("You've reached your 5 free sessions for today")
- Frontend shows an upgrade prompt on 402

**Guest users** also get a 30-day free trial, tracked via a `guest_trial_start` timestamp in localStorage (set on first use). localStorage manipulation is accepted — not worth guarding against. On signup, the client sends `guest_trial_start` to the server so the Stripe trial ends at `guest_trial_start + 30 days`, preserving remaining days.

---

## Stripe Integration — Recommended Approach

**Use Stripe Checkout (hosted page).** Reasons:
- Handles PCI compliance automatically
- Built-in support for BRL, PIX, cards, coupons, trial periods
- Much less code than Stripe Elements
- Mobile-friendly out of the box

### Flow

```
User clicks "Upgrade"
  → Backend creates a Checkout Session
  → Frontend redirects to Stripe-hosted checkout URL
  → User pays on Stripe's page
  → Stripe redirects back to /billing/success
  → Stripe fires webhook → backend marks user as subscribed
```

### Webhook events to handle

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Mark user as active subscriber |
| `invoice.payment_succeeded` | Renew subscription period |
| `invoice.payment_failed` | Send payment-failure email, grace period |
| `customer.subscription.deleted` | Downgrade to free tier |
| `customer.subscription.updated` | Handle plan changes / cancellations |

---

## Database Changes

Add to `users` table:

```sql
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'free';
  -- values: 'free' | 'active' | 'past_due' | 'canceled'
ALTER TABLE users ADD COLUMN subscription_id TEXT;
ALTER TABLE users ADD COLUMN subscription_current_period_end TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN trial_started_at TIMESTAMPTZ;
  -- set from guest_trial_start on signup to preserve remaining trial days
ALTER TABLE users ADD COLUMN is_comped BOOLEAN DEFAULT FALSE;
  -- comped users bypass subscription checks entirely (early adopters, press, partners)
```

---

## Backend Changes (FastAPI)

New endpoints:
- `POST /billing/checkout` — create Stripe Checkout Session, return URL
- `GET  /billing/portal`   — create Stripe Customer Portal session (for cancellation/card update)
- `POST /billing/webhook`  — receive and verify Stripe webhook events

Existing endpoints:
- Session-start: add free-tier gate (check count + subscription status)

New dependency:
```
stripe==9.*
```

---

## Frontend Changes

- "Upgrade" button/banner shown to free users (subtle, not annoying)
- On 402 from session-start: show modal "You've reached your 5 free sessions today. Upgrade for unlimited."
- `/billing/success` page: confirmation message
- Manage subscription link → calls `/billing/portal` and redirects

---

## New Environment Variables

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_...`) |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key (sent to frontend) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for webhook verification |
| `STRIPE_PRICE_ID` | Price ID of the $1.49/month plan |

---

## Stripe Setup Checklist (before coding)

1. Create Stripe account at stripe.com/br (Brazilian entity)
2. Complete business verification (CNPJ, company address, bank account in Brazil)
3. Create Product "Doing It Pro" with one price: $1.49/month (USD)
4. Enable international card payments in the Stripe Dashboard
5. Set up webhook endpoint pointing to `https://doingit.online/billing/webhook`
6. Copy keys and price IDs into Fly.io secrets

---

## Cost Projections

**Why infrastructure costs are negligible**

The countdown timer is pure client-side JavaScript (`setInterval`). No server requests are made while a session is running. The server is only hit on page load and on each session start/stop — roughly 21 requests/day for a heavy user. A tab open all day costs essentially nothing.

Database storage per user is also tiny: each session record is ~100 bytes. A heavy user logging 10 sessions/day for a year generates ~365KB. 1,000 users ≈ 365MB total.

**Projected costs at different scales**

| Scale | Paying users | MRR | Fly compute | Fly Postgres | Stripe fees (~23%) | Net MRR |
|-------|-------------|-----|-------------|--------------|-------------------|---------|
| Early | 50 | $75 | $0 (free tier) | $0 (free tier) | ~$17 | ~$58 |
| Growing | 500 | $745 | ~$10 | ~$10 | ~$171 | ~$554 |
| Scaled | 2,000 | $2,980 | ~$20 | ~$20 | ~$680 | ~$2,260 |

Fly.io's free tier covers 3 small VMs and a small Postgres instance — enough for the first ~100 users with zero infrastructure spend.

**The dominant cost at this price point is Stripe, not servers.** The fixed $0.30/charge makes fees ~23% of revenue regardless of scale. Infrastructure only becomes a meaningful line item in the thousands of users.

