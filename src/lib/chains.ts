// Supported chains. chainId matches the standard provider list so feed entries stay interchangeable.

export interface ChainInfo {
  chainId: number;
  key: string;
  name: string;
  /** True for the production networks shown in wallets; testnets are opt-in. */
  mainnet: boolean;
}

export const CHAINS: ChainInfo[] = [
  { chainId: 14, key: "flare", name: "Flare", mainnet: true },
  { chainId: 19, key: "songbird", name: "Songbird", mainnet: true },
  { chainId: 16, key: "coston", name: "Coston", mainnet: false },
  { chainId: 114, key: "coston2", name: "Coston2", mainnet: false },
];

const BY_ID = new Map(CHAINS.map((c) => [c.chainId, c]));

export function getChain(chainId: number): ChainInfo | undefined {
  return BY_ID.get(chainId);
}

export function isSupportedChain(chainId: number): boolean {
  return BY_ID.has(chainId);
}
