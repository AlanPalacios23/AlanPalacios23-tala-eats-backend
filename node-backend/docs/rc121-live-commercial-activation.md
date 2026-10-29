# RC12.1 LIVE activation prerequisites and observed blockers (2026-10-29)

Operator report, read-only:
- Five of six stale operational outbox events cleared after RC12.0; one non-order
  event remains. Preserve it until its type and financial dependencies are reviewed.
- One restaurant exists, zero have verified status or approved LIVE checkout.
- One ADMIN-verified driver exists, zero are online or available with fresh GPS.
- Zero driver Stripe Connect owner mappings have been approved.
- All three LIVE cash delivery release flags remain false.
- LIVE card delivery is hard disabled in config; production transfer flag and
  treasury executor are independently hard disabled; treasury HTTP/worker
  execution has not been released.
- Full E2E commercial pilot, external alert receipt and backup restore proof
  have not yet been verified.

RC12.1 code fix:
- The RC115 Stripe connected balance request now passes an empty parameters
  object and a separate RequestOptions object carrying stripeAccount, matching
  the existing production treasury Wallet router. A failed account balance
  GET no longer proves a disabled or unverified Stripe Connect account.

Safe release order:
1. Operator approves the real restaurant owner, correct restaurant catalog and
   actual MX Stripe Connect mapping (never fake KYC).
2. Approved courier logs in via courier PWA, goes online and sends fresh GPS.
3. After signed and reconciled cash order pilot with PIN and finance ledgers,
   independently release all three production cash flags atomically with
   rollback and canary, not before.
4. Complete separate Stripe TEST card-at-door E2E; then introduce independently
   reviewed LIVE card release. Pickup card success is not delivery proof.
5. Reconcile signed capture/merchant+driver split, connected balances, bank
   destination, known provider payouts, bank schedule, owner MFA and two
   independent ADMIN approvals before enabling real transfers/withdrawals.
6. Resolve remaining non-order outbox event, prove a real restore and alert
   receipt, then run a real three-PWA pilot before launch approval.

Never release cash/card delivery merely to make a green dashboard. Never
treat platform Stripe balance or a fake/test account as merchant earnings.
