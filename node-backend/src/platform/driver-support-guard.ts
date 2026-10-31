/** RC154 driver ticket boundary. Customer and ADMIN support retain their
 * historical contract. This gate applies only to the driver role.
 */
export const DRIVER_SUPPORT_CATEGORIES=[
 'delivery_issue','merchant_issue','safety_issue','finance_question'
] as const;
export const DRIVER_SUPPORT_MAX_IN_WINDOW=8;
export const DRIVER_SUPPORT_WINDOW_MS=15*60*1000;
export const DRIVER_SUPPORT_DEDUP_MS=2*60*1000;

export function validDriverSupportPayload(category:unknown,message:unknown):boolean{
 return typeof category==='string'&&
   DRIVER_SUPPORT_CATEGORIES.some(value=>value===category)&&
   typeof message==='string'&&message.trim().length>=12&&
   message.length<=1200&&message===message.trim();
}
export function driverSupportQuotaExceeded(recentCount:number):boolean{
 return !Number.isSafeInteger(recentCount)||recentCount>=DRIVER_SUPPORT_MAX_IN_WINDOW||recentCount<0;
}
