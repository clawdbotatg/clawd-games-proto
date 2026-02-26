/**
 * ClawdGames Keeper Service
 *
 * Two jobs:
 *  1. Event watcher: listens for Committed events → calls fulfillSeed(player, randomSecret)
 *  2. HTTP API:      POST /resolve { playerAddress, seed, moves, betAmount }
 *                    → runs simulate() → calls resolve(player, isWin)
 */

import express from "express";
import cors from "cors";
import { ethers, randomBytes } from "ethers";

// ---------------------------------------------------------------------------
// Inline DeterministicDice — exact port of github.com/austintgriffith/deterministic-dice
// Uses ethers.keccak256 for rehashing which matches noble/hashes keccak_256
// ---------------------------------------------------------------------------

class DeterministicDice {
  private entropy: string;
  private position: number;

  constructor(randomHash: string) {
    this.entropy = randomHash.startsWith("0x") ? randomHash.slice(2) : randomHash;
    this.position = 0;
  }

  roll(n: number): number {
    const bitsNeeded      = Math.ceil(Math.log2(n));
    const hexCharsNeeded  = Math.max(1, Math.ceil(bitsNeeded / 4));
    const maxValue        = Math.pow(16, hexCharsNeeded);
    const threshold       = maxValue - (maxValue % n);

    let value: number;
    do {
      value = this.consumeHex(hexCharsNeeded);
    } while (value >= threshold);

    return value % n;
  }

  private consumeHex(count: number): number {
    let result = 0;
    for (let i = 0; i < count; i++) {
      if (this.position >= this.entropy.length) {
        // keccak256(hexToBytes(entropy)) — matches noble keccak_256
        this.entropy = ethers.keccak256("0x" + this.entropy).slice(2);
        this.position = 0;
      }
      result = (result << 4) + parseInt(this.entropy[this.position], 16);
      this.position++;
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Config (env vars with local defaults)
// ---------------------------------------------------------------------------

const RPC_URL          = process.env.RPC_URL       || "http://127.0.0.1:8545";
const PRIVATE_KEY      = process.env.KEEPER_PK     || "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDR || "0xA15BB66138824a1c7167f5E85b957d04Dd34E468";
const PORT             = parseInt(process.env.PORT || "3001");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_MS || "2000");

// ---------------------------------------------------------------------------
// ABI (only what we need)
// ---------------------------------------------------------------------------

const LOOTBOX_ABI = [
  // Events
  "event Committed(address indexed player, bytes32 commitment, uint256 betAmount, uint256 blockNumber)",
  "event SeedFulfilled(address indexed player, bytes32 finalSeed)",
  "event RunCompleted(address indexed player, bytes32 finalSeed, uint256 betAmount, bool isWin, uint256 payout)",

  // State reads
  "function pendingRuns(address) view returns (bytes32 commitment, bytes32 finalSeed, uint256 betAmount, bool active, bool seedFulfilled, bool resolved)",

  // Keeper writes
  "function fulfillSeed(address player, bytes32 keeperSecret) external",
  "function resolve(address player, bool isWin) external",
] as const;

// ---------------------------------------------------------------------------
// Setup provider / signer / contract
// ---------------------------------------------------------------------------

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer   = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, LOOTBOX_ABI, signer);

console.log(`[keeper] Starting — contract: ${CONTRACT_ADDRESS}`);
console.log(`[keeper] Keeper wallet: ${signer.address}`);
console.log(`[keeper] RPC: ${RPC_URL}`);

// ---------------------------------------------------------------------------
// Simulate helper — pure, matches DeterministicDice on frontend
// ---------------------------------------------------------------------------

interface SimulateResult {
  obstacles:  number[];  // 5 positions 0-99
  isWin:      boolean;
  payout:     bigint;
  cleared:    boolean[]; // cosmetic: did player clear each obstacle?
}

const RUN_DURATION_MS = 8000; // ms for the full run animation
const JUMP_DURATION_MS = 800; // ms player is in the air after a jump

function simulate(seed: string, moves: number[], betAmount: bigint): SimulateResult {
  const dice = new DeterministicDice(seed);

  // Derive 5 obstacle positions (same order as contract / frontend)
  const obstacles = Array.from({ length: 5 }, () => dice.roll(100));

  // Loot box outcome (the only thing that matters for payout)
  const isWin = dice.roll(10) === 0;

  // Cosmetic: did player clear each obstacle?
  const cleared = obstacles.map((obsPos) => {
    // Obstacle reached at time: (obsPos / 100) * RUN_DURATION_MS
    const obstacleTime = (obsPos / 100) * RUN_DURATION_MS;
    // Player clears if any jump started within [obstacleTime - JUMP_DURATION_MS, obstacleTime]
    return moves.some(
      (jumpT) => jumpT <= obstacleTime && jumpT >= obstacleTime - JUMP_DURATION_MS
    );
  });

  const payout = isWin ? betAmount * 9n : 0n;

  return { obstacles, isWin, payout, cleared };
}

// ---------------------------------------------------------------------------
// Job 1: Fulfill seeds
// ---------------------------------------------------------------------------

const pendingFulfills = new Set<string>(); // prevent double-fulfills

async function fulfillForPlayer(player: string): Promise<void> {
  if (pendingFulfills.has(player.toLowerCase())) return;
  pendingFulfills.add(player.toLowerCase());

  try {
    const run = await contract.pendingRuns(player) as { active: boolean; seedFulfilled: boolean; resolved: boolean };
    if (!run.active || run.seedFulfilled || run.resolved) {
      pendingFulfills.delete(player.toLowerCase());
      return;
    }

    const keeperSecret = ethers.hexlify(randomBytes(32)) as `0x${string}`;
    console.log(`[keeper] Fulfilling seed for ${player} | secret: ${keeperSecret.slice(0, 10)}...`);

    const tx = await contract.fulfillSeed(player, keeperSecret);
    const receipt = await tx.wait();
    console.log(`[keeper] SeedFulfilled for ${player} | tx: ${receipt?.hash}`);
  } catch (err) {
    console.error(`[keeper] Error fulfilling for ${player}:`, err);
  } finally {
    pendingFulfills.delete(player.toLowerCase());
  }
}

// Event-based listener
async function startEventWatcher(): Promise<void> {
  console.log("[keeper] Watching for Committed events...");

  contract.on("Committed", async (player: string) => {
    console.log(`[keeper] Committed event — player: ${player}`);
    await fulfillForPlayer(player);
  });

  // Also poll for any missed events (handles restarts)
  setInterval(async () => {
    try {
      const filter = contract.filters.Committed();
      const latestBlock = await provider.getBlockNumber();
      const fromBlock   = Math.max(0, latestBlock - 100);
      const events = await contract.queryFilter(filter, fromBlock, latestBlock);

      for (const ev of events) {
        const player = (ev as ethers.EventLog).args[0] as string;
        const run = await contract.pendingRuns(player) as { active: boolean; seedFulfilled: boolean };
        if (run.active && !run.seedFulfilled) {
          await fulfillForPlayer(player);
        }
      }
    } catch (_) {
      // Ignore polling errors (chain may be lagging)
    }
  }, POLL_INTERVAL_MS * 5);
}

// ---------------------------------------------------------------------------
// Job 2: HTTP API
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", keeper: signer.address, contract: CONTRACT_ADDRESS });
});

interface ResolveBody {
  playerAddress: string;
  seed:          string;
  moves:         number[];
  betAmount:     string; // BigInt as string
}

app.post("/resolve", async (req, res) => {
  const { playerAddress, seed, moves, betAmount } = req.body as ResolveBody;

  if (!playerAddress || !seed || !Array.isArray(moves)) {
    res.status(400).json({ error: "Missing required fields: playerAddress, seed, moves" });
    return;
  }

  console.log(`[keeper] /resolve — player: ${playerAddress}, seed: ${seed.slice(0, 10)}..., moves: [${moves.join(",")}]`);

  try {
    // Simulate
    const betBigInt = BigInt(betAmount || "0");
    const result    = simulate(seed, moves, betBigInt);

    console.log(`[keeper] simulate → isWin: ${result.isWin}, obstacles: [${result.obstacles.join(",")}]`);

    // Verify the on-chain seed matches what we simulated
    const run = await contract.pendingRuns(playerAddress) as {
      active:        boolean;
      seedFulfilled: boolean;
      finalSeed:     string;
      resolved:      boolean;
    };

    if (!run.active || !run.seedFulfilled) {
      res.status(400).json({ error: "Run not ready to resolve (not active or seed not fulfilled)" });
      return;
    }

    if (run.resolved) {
      res.status(400).json({ error: "Run already resolved" });
      return;
    }

    // Verify seed matches on-chain stored seed
    if (run.finalSeed.toLowerCase() !== seed.toLowerCase()) {
      console.warn(`[keeper] Seed mismatch! On-chain: ${run.finalSeed}, provided: ${seed}`);
      res.status(400).json({ error: "Seed mismatch — use the seed from SeedFulfilled event" });
      return;
    }

    // Call resolve on-chain
    const tx      = await contract.resolve(playerAddress, result.isWin);
    const receipt = await tx.wait();

    console.log(`[keeper] RunCompleted — player: ${playerAddress}, isWin: ${result.isWin}, tx: ${receipt?.hash}`);

    res.json({
      isWin:      result.isWin,
      payout:     result.payout.toString(),
      obstacles:  result.obstacles,
      cleared:    result.cleared,
      txHash:     receipt?.hash,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[keeper] /resolve error:", msg);
    res.status(500).json({ error: msg });
  }
});

// Simulate-only endpoint (no tx) — for frontend preview
app.post("/simulate", (req, res) => {
  const { seed, moves, betAmount } = req.body as { seed: string; moves: number[]; betAmount: string };
  if (!seed || !Array.isArray(moves)) {
    res.status(400).json({ error: "Missing seed or moves" });
    return;
  }
  const result = simulate(seed, moves, BigInt(betAmount || "0"));
  res.json({ ...result, payout: result.payout.toString() });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Verify connection
  const network = await provider.getNetwork();
  console.log(`[keeper] Connected to chain ${network.chainId}`);

  // Start event watcher
  await startEventWatcher();

  // Start HTTP server
  app.listen(PORT, () => {
    console.log(`[keeper] HTTP server on port ${PORT}`);
    console.log(`[keeper] POST http://localhost:${PORT}/resolve  { playerAddress, seed, moves, betAmount }`);
  });
}

main().catch((err) => {
  console.error("[keeper] Fatal error:", err);
  process.exit(1);
});
