export const PACKAGE_NAME = "@openeuler/drivers";

export interface DriverDescriptor {
  id: string;
  label: string;
}

export const PLACEHOLDER_DRIVERS: readonly DriverDescriptor[] = Object.freeze([
  { id: "placeholder", label: "Placeholder driver" },
]);

export function listDriverIds(): string[] {
  return PLACEHOLDER_DRIVERS.map((driver) => driver.id);
}
