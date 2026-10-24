/**
 * RC8.12 - explicit worker-readiness contract.
 *
 * A staging API with checkout/dispatch enabled MUST NOT advertise ready=true
 * merely because PostgreSQL + Redis respond. Dispatch, Stripe reconciliation,
 * outbox processing and recovery run in a separate worker process.
 *
 * API-only staging (all workflow flags off) remains usable for CI and
 * read-only experimentation without a worker. Production remains fail-closed
 * on its worker heartbeat AND the existing financial integrity audit.
 *
 * Pure function: no I/O, no Stripe, no database writes.
 */
export type ReadinessFlags = {
  nodeEnv:'staging'|'production';
  workerOnline:boolean;
  financialAuditPass:boolean;
  stagePickupCashEnabled:boolean;
  stageDeliveryCashEnabled:boolean;
  stageStripeTestEnabled:boolean;
  stageDeliveryStripeTestEnabled:boolean;
  stageDriverEnabled:boolean;
};

export type RuntimeReadiness = {
  ready:boolean;
  workerRequired:boolean;
};

export function computeRuntimeReadiness(input:ReadinessFlags):RuntimeReadiness {
  const workerRequired=input.nodeEnv==='production'||(
    input.stagePickupCashEnabled||
    input.stageDeliveryCashEnabled||
    input.stageStripeTestEnabled||
    input.stageDeliveryStripeTestEnabled||
    input.stageDriverEnabled
  );
  return {
    workerRequired,
    ready:input.nodeEnv==='production'
      ?input.workerOnline&&input.financialAuditPass
      :!workerRequired||input.workerOnline,
  };
}
