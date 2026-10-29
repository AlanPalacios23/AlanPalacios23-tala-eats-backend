/**
 * RC13.3 — immutable general-ledger journal contract, NO side effects.
 * Amounts are bigint MXN centavos. This is bookkeeping, NOT a bank balance,
 * a receipt from Stripe, a cash-custody proof, or authorization to pay.
 */
import {createHash} from 'node:crypto';

export type MoneyAccountKey=string;
export type JournalSide='debit'|'credit';
export type JournalLineInput={
  accountKey:MoneyAccountKey;side:JournalSide;amountMinor:bigint;
};
export type JournalInput={
  eventKey:string;
  sourceType:'order'|'delivery'|'cash_handoff'|'stripe_event'|'bank_event'|
   'settlement'|'refund'|'dispute'|'adjustment';
  sourceRef:string;description:string;
  lines:readonly JournalLineInput[];
};
export type PostedLine=JournalLineInput&{lineNo:number};
export type JournalPlan=Omit<JournalInput,'lines'>&{
  currency:'mxn';fingerprint:string;lines:readonly PostedLine[];
  debitsMinor:bigint;creditsMinor:bigint;
};
export class JournalInvalid extends Error{
 constructor(readonly reason:string){super(reason);}
}
const KEY=/^[a-z][a-z0-9_.:-]{2,119}$/;
const EVENT=/^[a-zA-Z0-9_.:-]{8,180}$/;
const REF=/^[a-zA-Z0-9_.:-]{1,120}$/;
const LIMIT=9_000_000_000_000n;
function ensure(ok:boolean,reason:string):void {
 if(!ok)throw new JournalInvalid(reason);
}
export function prepareJournal(input:JournalInput):JournalPlan{
 ensure(typeof input.eventKey==='string'&&EVENT.test(input.eventKey),
  'JOURNAL_EVENT_KEY_INVALID');
 ensure(typeof input.sourceRef==='string'&&REF.test(input.sourceRef),
  'JOURNAL_SOURCE_REFERENCE_INVALID');
 ensure(['order','delivery','cash_handoff','stripe_event','bank_event',
  'settlement','refund','dispute','adjustment'].includes(input.sourceType),
  'JOURNAL_SOURCE_TYPE_INVALID');
 ensure(typeof input.description==='string'&&input.description.trim().length>2&&
  input.description.length<=200,'JOURNAL_DESCRIPTION_INVALID');
 ensure(Array.isArray(input.lines)&&input.lines.length>=2&&
  input.lines.length<=64,'JOURNAL_LINES_INVALID');
 let debits=0n,credits=0n;
 const copy=input.lines.map((line,i)=>{
  ensure(typeof line.accountKey==='string'&&KEY.test(line.accountKey),
   'JOURNAL_ACCOUNT_KEY_INVALID');
  ensure(line.side==='debit'||line.side==='credit',
   'JOURNAL_SIDE_INVALID');
  ensure(typeof line.amountMinor==='bigint'&&line.amountMinor>0n&&
   line.amountMinor<=LIMIT,'JOURNAL_AMOUNT_INVALID');
  if(line.side==='debit')debits+=line.amountMinor;
  else credits+=line.amountMinor;
  ensure(debits<=LIMIT&&credits<=LIMIT,'JOURNAL_SUM_OUT_OF_RANGE');
  return {lineNo:i+1,accountKey:line.accountKey,side:line.side,
   amountMinor:line.amountMinor};
 });
 ensure(debits===credits&&debits>0n,'JOURNAL_UNBALANCED');
 // Canonical event digest prevents an idempotency collision from silently
 // replaying a DIFFERENT financial posting under an existing event key.
 // Sort lines by account, side and amount; row number is presentation only.
 const canonical=copy.map(x=>[x.accountKey,x.side,x.amountMinor.toString()])
  .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 const payload=JSON.stringify({
  sourceType:input.sourceType,sourceRef:input.sourceRef,
  description:input.description,currency:'mxn',lines:canonical,
 });
 const fingerprint=createHash('sha256').update(payload).digest('hex');
 return {eventKey:input.eventKey,sourceType:input.sourceType,
  sourceRef:input.sourceRef,description:input.description,
  currency:'mxn',lines:copy,fingerprint,
  debitsMinor:debits,creditsMinor:credits};
}
