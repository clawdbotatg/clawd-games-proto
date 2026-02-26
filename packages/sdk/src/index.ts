/**
 * @clawd-games/sdk
 * SDK for interacting with the ClawdGames LootBoxGame contract.
 *
 * Key methods:
 *  - simulate(seed, moves, betAmount) — PURE, no network call, matches keeper/contract logic
 *  - getBalance(address)              — read GAME token balance
 *  - getSeed(address)                 — read fulfilled seed from pending run
 */

// DeterministicDice algorithm — inline to avoid ESM import issues in CJS consumers
// Exact port of github.com/austintgriffith/deterministic-dice (uses keccak256 for rehash)
import { keccak256 } from "viem";

class DeterministicDice {
  private entropy: string;
  private position: number;

  constructor(randomHash: string) {
    this.entropy = randomHash.startsWith("0x") ? randomHash.slice(2) : randomHash;
    this.position = 0;
  }

  roll(n: number): number {
    const bitsNeeded     = Math.ceil(Math.log2(n));
    const hexCharsNeeded = Math.max(1, Math.ceil(bitsNeeded / 4));
    const maxValue       = Math.pow(16, hexCharsNeeded);
    const threshold      = maxValue - (maxValue % n);
    let value: number;
    do { value = this.consumeHex(hexCharsNeeded); } while (value >= threshold);
    return value % n;
  }

  private consumeHex(count: number): number {
    let result = 0;
    for (let i = 0; i < count; i++) {
      if (this.position >= this.entropy.length) {
        this.entropy = keccak256(("0x" + this.entropy) as `0x${string}`).slice(2);
        this.position = 0;
      }
      result = (result << 4) + parseInt(this.entropy[this.position], 16);
      this.position++;
    }
    return result;
  }
}
import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
  type Hex,
} from "viem";
import { foundry, baseSepolia } from "viem/chains";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OBSTACLE_COUNT   = 5;
export const WIN_MULTIPLIER   = 9n;
export const RUN_DURATION_MS  = 8000;  // total run length in ms
export const JUMP_DURATION_MS = 800;   // time in air after jump

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimulateResult {
  obstacles:  number[];   // 5 positions 0-99 (0 = start, 99 = near loot box)
  isWin:      boolean;
  payout:     bigint;
  cleared:    boolean[];  // cosmetic — did player timing clear each obstacle?
}

export interface ClawdGamesConfig {
  gameTokenAddress:    Address;
  gameContractAddress: Address;
  rpcUrl:              string;
  chainId?:            number;
}

export interface PendingRun {
  commitment:    Hex;
  finalSeed:     Hex;
  betAmount:     bigint;
  active:        boolean;
  seedFulfilled: boolean;
  resolved:      boolean;
}

// ---------------------------------------------------------------------------
// Minimal ABIs
// ---------------------------------------------------------------------------

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
] as const;

const LOOTBOX_ABI = [
  {
    type: "function",
    name: "pendingRuns",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "commitment",    type: "bytes32" },
      { name: "finalSeed",     type: "bytes32" },
      { name: "betAmount",     type: "uint256" },
      { name: "active",        type: "bool" },
      { name: "seedFulfilled", type: "bool" },
      { name: "resolved",      type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getObstacles",
    inputs: [{ name: "seed", type: "bytes32" }],
    outputs: [{ name: "positions", type: "uint8[5]" }],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "predictOutcome",
    inputs: [{ name: "seed", type: "bytes32" }],
    outputs: [{ name: "isWin", type: "bool" }],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "prizePool",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Committed",
    inputs: [
      { name: "player",      type: "address", indexed: true },
      { name: "commitment",  type: "bytes32", indexed: false },
      { name: "betAmount",   type: "uint256", indexed: false },
      { name: "blockNumber", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SeedFulfilled",
    inputs: [
      { name: "player",    type: "address", indexed: true },
      { name: "finalSeed", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RunCompleted",
    inputs: [
      { name: "player",    type: "address", indexed: true },
      { name: "finalSeed", type: "bytes32", indexed: false },
      { name: "betAmount", type: "uint256", indexed: false },
      { name: "isWin",     type: "bool",    indexed: false },
      { name: "payout",    type: "uint256", indexed: false },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Pure simulate — matches keeper + contract DeterministicDice exactly
// ---------------------------------------------------------------------------

/**
 * Simulate a run purely in TypeScript. No network calls.
 *
 * @param seed      bytes32 hex string (0x...) — from SeedFulfilled event
 * @param moves     Array of jump timestamps in ms since run start
 * @param betAmount Bet in wei (bigint)
 */
export function simulate(
  seed: string,
  moves: number[],
  betAmount: bigint
): SimulateResult {
  const dice = new DeterministicDice(seed);

  // Derive obstacle positions — same order as contract's _deriveObstacles
  const obstacles = Array.from({ length: OBSTACLE_COUNT }, () => dice.roll(100));

  // Loot box outcome — the only thing that determines payout
  const isWin = dice.roll(10) === 0;

  // Cosmetic: check if player's jumps cleared each obstacle
  const cleared = obstacles.map((obsPos) => {
    // Time at which player reaches this obstacle
    const obstacleTime = (obsPos / 100) * RUN_DURATION_MS;
    // Cleared if any jump started in [obstacleTime - JUMP_DURATION_MS, obstacleTime]
    return moves.some(
      (t) => t <= obstacleTime && t >= obstacleTime - JUMP_DURATION_MS
    );
  });

  const payout = isWin ? betAmount * WIN_MULTIPLIER : 0n;

  return { obstacles, isWin, payout, cleared };
}

// ---------------------------------------------------------------------------
// ClawdGamesSDK class — on-chain reads
// ---------------------------------------------------------------------------

export class ClawdGamesSDK {
  private readonly client:     PublicClient;
  private readonly tokenAddr:  Address;
  private readonly gameAddr:   Address;

  constructor(config: ClawdGamesConfig) {
    const chain = config.chainId === 84532 ? baseSepolia : foundry;

    this.client    = createPublicClient({ chain, transport: http(config.rpcUrl) });
    this.tokenAddr = config.gameTokenAddress;
    this.gameAddr  = config.gameContractAddress;
  }

  /** Get GAME token balance for an address */
  async getBalance(address: Address): Promise<bigint> {
    return this.client.readContract({
      address:      this.tokenAddr,
      abi:          ERC20_ABI,
      functionName: "balanceOf",
      args:         [address],
    }) as Promise<bigint>;
  }

  /** Get pending run state for a player */
  async getPendingRun(address: Address): Promise<PendingRun> {
    const result = await this.client.readContract({
      address:      this.gameAddr,
      abi:          LOOTBOX_ABI,
      functionName: "pendingRuns",
      args:         [address],
    }) as [Hex, Hex, bigint, boolean, boolean, boolean];

    return {
      commitment:    result[0],
      finalSeed:     result[1],
      betAmount:     result[2],
      active:        result[3],
      seedFulfilled: result[4],
      resolved:      result[5],
    };
  }

  /** Get seed directly from the contract (fulfilled seed) */
  async getSeed(address: Address): Promise<Hex | null> {
    const run = await this.getPendingRun(address);
    if (!run.seedFulfilled) return null;
    return run.finalSeed;
  }

  /** Get prize pool balance */
  async getPrizePool(): Promise<bigint> {
    return this.client.readContract({
      address:      this.gameAddr,
      abi:          LOOTBOX_ABI,
      functionName: "prizePool",
    }) as Promise<bigint>;
  }

  /** Pure simulate — re-exported for convenience */
  simulate(seed: string, moves: number[], betAmount: bigint): SimulateResult {
    return simulate(seed, moves, betAmount);
  }

  /**
   * Watch for SeedFulfilled events for a specific player.
   * Returns an unsubscribe function.
   */
  watchSeedFulfilled(
    player: Address,
    onFulfilled: (seed: Hex) => void
  ): () => void {
    return this.client.watchContractEvent({
      address:   this.gameAddr,
      abi:       LOOTBOX_ABI,
      eventName: "SeedFulfilled",
      args:      { player },
      onLogs:    (logs) => {
        for (const log of logs) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const seed = (log as any).args?.finalSeed as Hex;
          if (seed) onFulfilled(seed);
        }
      },
    });
  }

  /**
   * Watch for RunCompleted events for a specific player.
   */
  watchRunCompleted(
    player: Address,
    onCompleted: (isWin: boolean, payout: bigint, seed: Hex) => void
  ): () => void {
    return this.client.watchContractEvent({
      address:   this.gameAddr,
      abi:       LOOTBOX_ABI,
      eventName: "RunCompleted",
      args:      { player },
      onLogs:    (logs) => {
        for (const log of logs) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const args = (log as any).args as { isWin: boolean; payout: bigint; finalSeed: Hex };
          if (args) onCompleted(args.isWin, args.payout, args.finalSeed);
        }
      },
    });
  }
}

export default ClawdGamesSDK;
