/** Server-side Driver admission policy for the production marketplace.
 * The browser's plate validation is UX only; neither signup nor ADMIN approval
 * may trust an unvalidated application record.
 * Bicycle uses an explicit empty plate; motor vehicles require a real plate.
 */
export type DriverVehicle='Motocicleta'|'Automóvil'|'Bicicleta';
export function validDriverVehiclePlate(vehicle:unknown,plate:unknown):boolean{
 if(typeof vehicle!=='string'||typeof plate!=='string')return false;
 const normalized=plate.trim().toUpperCase();
 if(vehicle==='Bicicleta')return normalized==='';
 if(vehicle!=='Motocicleta'&&vehicle!=='Automóvil')return false;
 return /^(?=.{4,12}$)[A-Z0-9]+(?:[ -][A-Z0-9]+)*$/.test(normalized);
}
