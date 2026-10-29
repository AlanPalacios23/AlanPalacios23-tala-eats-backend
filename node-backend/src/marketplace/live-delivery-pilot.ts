/**
 * RC12.9 limited LIVE delivery pilot admission. Pure logic: no DB/Stripe/Redis.
 *
 * A global checkout/dispatch flag must never enroll every public customer
 * during the first real-world trial. Three different identities are pinned:
 * customer, merchant and driver. An invalid/missing ID denies eligibility.
 */
const valid=(n:unknown):n is number=>
 typeof n==='number'&&Number.isSafeInteger(n)&&n>0;

export function pilotBuyerAndStoreAllowed(
  env:string,customerId:unknown,restaurantId:unknown,
  allowedCustomer:unknown,allowedRestaurant:unknown,
):boolean{
 return env==='production'&&
  valid(customerId)&&valid(restaurantId)&&
  valid(allowedCustomer)&&valid(allowedRestaurant)&&
  customerId===allowedCustomer&&restaurantId===allowedRestaurant;
}
export function pilotDriverAllowed(
  env:string,driverId:unknown,allowedDriver:unknown,
):boolean{
 return env==='production'&&valid(driverId)&&valid(allowedDriver)&&
  driverId===allowedDriver;
}
