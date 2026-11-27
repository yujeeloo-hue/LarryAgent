export type ComputerLoginIdentity = { origin: string; account: string };
export type ComputerLoginList = { available: boolean; entries: ComputerLoginIdentity[] };
