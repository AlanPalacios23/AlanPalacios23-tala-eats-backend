import importlib.util
from pathlib import Path
import unittest

FILE=Path(__file__).with_name("rc814-enable-live-pickup-cash.py")
SPEC=importlib.util.spec_from_file_location("cash_live",FILE)
cash=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cash)

GOOD={
 "NODE_ENV":"production","HOST":"127.0.0.1","PORT":"18190",
 "DATABASE_URL":"postgresql://tala_node_live:private@127.0.0.1:15445/tala_node_live",
 "STRIPE_LIVE_ENABLED":"true","STRIPE_FINANCIAL_WRITES_ENABLED":"true",
 "STRIPE_LIVE_RELEASE_APPROVED":"true","STRIPE_REFUNDS_ENABLED":"true",
 "STRIPE_MANUAL_SETTLEMENT_APPROVED":"true",
 "STAGE_STRIPE_TEST_CHECKOUT_ENABLED":"false",
 "STAGE_DELIVERY_CASH_CHECKOUT_ENABLED":"false",
 "STAGE_DELIVERY_STRIPE_TEST_ENABLED":"false",
 "STRIPE_CONNECT_TRANSFERS_ENABLED":"false",
 "STAGE_PICKUP_CASH_CHECKOUT_ENABLED":"true",
 "LIVE_PICKUP_CASH_CHECKOUT_ENABLED":"false",
 "LIVE_PICKUP_CASH_RELEASE_APPROVED":"false",
}
class CashLiveContractTests(unittest.TestCase):
 def test_production_cash_flag_can_only_change_with_real_live_financial_mode(self):
  cash.preconditions(GOOD)
  for name,value in [
   ("NODE_ENV","staging"),("PORT","18192"),
   ("DATABASE_URL","postgresql://tala_node_stage:x@127.0.0.1:15435/tala_node_stage"),
   ("STRIPE_LIVE_ENABLED","false"),
   ("STRIPE_FINANCIAL_WRITES_ENABLED","false"),
   ("STRIPE_CONNECT_TRANSFERS_ENABLED","true"),
   ("STAGE_STRIPE_TEST_CHECKOUT_ENABLED","true"),
  ]:
   with self.subTest(name=name):
    with self.assertRaises(SystemExit):
     cash.preconditions({**GOOD,name:value})
 def test_env_parser_does_not_tolerate_duplicate_flag_override(self):
  with self.assertRaises(SystemExit):
   cash.settings("LIVE_PICKUP_CASH_CHECKOUT_ENABLED=false\nLIVE_PICKUP_CASH_CHECKOUT_ENABLED=true")
 def test_source_has_no_provider_writes_or_unreviewed_prod_mutations(self):
  s=FILE.read_text()
  for required in [
   "I_APPROVE_RC814_PRODUCTION_CASH_PICKUP_ONLY",
   "LIVE_PICKUP_CASH_CHECKOUT_ENABLED",
   "LIVE_PICKUP_CASH_RELEASE_APPROVED",
   "RC122_PAIR_NOT_ATOMIC",
   "rc814-pre-live-cash-",
   "BEGIN TRANSACTION READ ONLY",
   "tala_node_live",
   "RC122_LIVE_CASH_PICKUP_ALREADY_ENABLED=PASS",
   "RC814_CASH_ENV_ROLLBACK_ATTEMPTED_OPERATOR_REVIEW_REQUIRED",
   "RC814_NO_STRIPE_CHARGE_OR_CONNECT_PAYOUT=YES",
  ]:self.assertIn(required,s)
  for disallowed in ["prisma migrate deploy","FLUSHDB","FLUSHALL",
   "cloudflared restart","stripe.paymentIntents.create","stripe.transfers.create"]:
   self.assertNotIn(disallowed,s)
if __name__=="__main__":
 unittest.main()
