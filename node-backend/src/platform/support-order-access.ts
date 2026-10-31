/** RC153 driver-to-order ticket authorization.
 * This guard is deliberately pure and fail closed. No customer, merchant or
 * driver can link a support ticket to someone else's order by guessing its ID.
 */
export type SupportOrderActor={id:number;role:string};
export type SupportOrderLink={userId:number;driverId:number|null;orderType:string};

export function mayLinkSupportOrder(
 actor:SupportOrderActor,order:SupportOrderLink|null,
 driverOrderSupportEnabled:boolean,
):boolean{
 if(!order||!Number.isSafeInteger(actor.id)||actor.id<=0)return false;
 if(actor.role==='admin')return true; // ADMIN MFA is enforced by current(req).
 // Role-specific first: a driver cannot use an incidental buyer match to bypass
 // the assignment or the OFF switch.
 if(actor.role==='driver')return driverOrderSupportEnabled&&
   order.orderType==='delivery'&&
   Number.isSafeInteger(order.driverId)&&
   order.driverId===actor.id;
 return order.userId===actor.id; // Preserve historical non-driver buyer permission.
}
