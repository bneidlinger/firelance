// Everything discrete the simulation produces, consumed by the network layer,
// the test harness, and bots alike. Grows every milestone (kill, hit, bank,
// keepDestroyed, ...). Discriminated on `k`.
export type SimEvent =
  | { k: 'playerJoined'; id: number; squad: number; name: string; bot: boolean }
  | { k: 'playerLeft'; id: number };
