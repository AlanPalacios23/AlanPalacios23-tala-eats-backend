/** RC8.6: pure seller payout eligibility, no auth/config/Stripe imports.
 * Must be testable offline on Kali with no NODE_ENV, DB or payment secrets.
 */
export function settlementEligibility(o:{
 status:string;paymentStatus:string;total:number;payout:number;refunded:number;
 captured:boolean;cases:number;approved:boolean;transfers:boolean;
 payouts:boolean;details:boolean;transferRecorded:boolean
}):{eligible:boolean;reasons:string[]}{
 const reasons:string[]=[];
 if(o.status!=='delivered')reasons.push('DELIVERY_NOT_CONFIRMED');
 if(o.paymentStatus!=='paid'||o.refunded!==0)reasons.push('REFUND_OR_UNPAID');
 if(!Number.isSafeInteger(o.total)||!Number.isSafeInteger(o.payout)||
    o.payout<1||o.payout>o.total)reasons.push('INVALID_PAYOUT_AMOUNT');
 if(!o.captured)reasons.push('SIGNED_CAPTURE_NOT_POSTED');
 if(o.cases!==0)reasons.push('OPEN_REFUND_OR_DISPUTE');
 if(!o.approved||!o.transfers||!o.payouts||!o.details)
  reasons.push('SELLER_CONNECT_INCOMPLETE');
 if(o.transferRecorded)reasons.push('SETTLEMENT_ALREADY_APPROVED');
 return {eligible:reasons.length===0,reasons};
}
