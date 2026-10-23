/** Pure financial-release classifier; safe to test without DB credentials. */
export type Rc7GateCounters={
  stuckIntentReservations:number;
  overdueUnpaidCardOrders:number;
  unreconciledSignedWebhooks:number;
  paidOrdersMissingTrustedReceipt:number;
  cardCashMisclassification:number;
  paidOrderSampleTruncated:number;
};
export const classifyRc7FinancialData=(input:Rc7GateCounters):
  'STAGE_FINANCIAL_DATA_PASS'|'STAGE_FINANCIAL_DATA_HOLD'=>(
    Object.values(input).every(n=>Number.isSafeInteger(n)&&n===0)
    ?'STAGE_FINANCIAL_DATA_PASS':'STAGE_FINANCIAL_DATA_HOLD'
  );
