/** RC12.6: onboarding is not an implicit commercial role-switch.
 * Fresh customers may apply to become restaurant owners or couriers.
 * Existing merchants/couriers may only reapply for their existing role.
 * ADMIN identities can never be converted by self-submitted onboarding.
 */
export type CommercialApplicationRole='restaurant'|'driver';
export function canUseCommercialOnboardingRole(
 currentRole:string,target:CommercialApplicationRole,
):boolean {
 return currentRole==='customer'||currentRole===target;
}
