# ClawdGames Platform — Vision & User Flow
*Documented 2026-03-09 by clawdgut after research across 3 repos*

---

## The One-Liner

A platform where game devs iframe in their deterministic game, and players spend CLAWD/game tokens to play — with all crypto handled invisibly by the platform.

---

## Prior Art (Research Summary)

Three previous attempts inform this build:

| Repo | What it has |
|---|---|
| `clawdbotatg/clawdgames` | Full platform design doc — token launch via Flow Protocol, CLAWD flywheel, fee economy |
| `clawdbotatg/clawd-games-proto` | Working game loop — lobster runner, commit-reveal, DeterministicDice Solidity lib, keeper service |
| `austintgriffith/slop-computer-two` | Most complete — CommitReveal contract, GameTreasury, headless resolver engine, passkey wallets (not using passkeys), game type taxonomy (Types 1-4), iframe SDK design |

---

## The Full User Flow

### 1. Player Connects
- Platform: SE2 (Scaffold-ETH 2), RainbowKit wallet connect
- Player connects their wallet on `clawdgames.xyz`

### 2. Player Gets Game Tokens
- Player spends CLAWD / USDC / ETH
- Platform swaps to the game-specific token (e.g. `$DODGE`)
- All swap/token logic handled by the platform — player just clicks "Get tokens"

### 3. Player Starts a Game
- Player clicks Play on a game
- Platform calls `charge()` on-chain:
  - Deducts game tokens from player
  - Kicks off commit-reveal randomness
  - Returns a `gameId` and eventually a `seed`
- Platform iframes in the game URL
- Seed is injected into the iframe via the SDK (`sdk.start(seed)`)

### 4. Player Plays
- Game runs deterministically from the seed
- All randomness derives from seed via `deterministic-dice`
- Player's inputs/moves are recorded by the SDK (`sdk.recordMove(move)`)
- Game dev knows nothing about crypto — they just build a game that accepts a seed

### 5. Player Finishes
- Player completes the game
- Game calls `sdk.finish(moves[])` — hands timestamped moves + gameId back to platform
- Platform/keeper receives this

### 6. Resolution
- Keeper hits the game's `/simulate` endpoint with `{ seed, moves }`
- Gets back the outcome (win/loss, collectibles, score, etc.)
- Keeper resolves on-chain, pays out game tokens to player's wallet

---

## The SDK (Platform → Game Bridge)

Injected into the game iframe via postMessage. Game dev uses this:

```typescript
// Game receives seed and starts
sdk.on('start', (seed: string) => {
  // initialize your game with this seed
  // all randomness must derive from seed
})

// Game records player moves (timestamped automatically)
sdk.recordMove({ type: 'jump', x: 120, y: 80 })
sdk.recordMove({ type: 'direction', dir: 'left' })

// Game finishes, hands moves to keeper
sdk.finish() // SDK handles sending all recorded moves
```

**Dev/Test mode:** When the game is iframed from anywhere other than the production platform, the SDK:
- Uses fake/test tokens (same game behavior, different token source)
- Shows a visible "TEST MODE" indicator to the player
- This is critical — devs can test many times before going live

---

## The Game Dev's Contract

A game is valid on ClawdGames if it:

1. **Accepts a seed** — all randomness derives from `deterministic-dice` seeded by the platform
2. **Uses the SDK** — `sdk.start()`, `sdk.recordMove()`, `sdk.finish()`
3. **Exposes `/simulate`** — `POST /simulate { seed, moves }` → returns outcome instantly (no animation, pure calculation)
4. **Is hosted anywhere** — game dev self-hosts, registers their URL with the platform

The game dev never writes Solidity or thinks about wallets.

---

## The `/simulate` Endpoint (Required for Every Game)

```
POST /simulate
Body: { seed: "0x...", moves: [{ type, t, ...data }] }

Response: {
  isWin: boolean,
  payout: number,        // multiplier or token amount
  outcome: { ... }       // game-specific result data
}
```

The keeper calls this to verify what actually happened in the game before paying out. Same seed + same moves = same result, always.

---

## Platform Architecture

```
clawdgames.xyz (SE2 Next.js)
├── RainbowKit wallet connect
├── Game registry (list of games + their iframe URLs)
├── Token swap UI (CLAWD/USDC/ETH → game token)
├── Game shell page (/game/[id])
│   ├── Top bar: balance, game name, exit
│   └── iframe: the game itself
├── Keeper API
│   ├── POST /api/start  → charge player, commit-reveal, return seed
│   ├── POST /api/finish → receive moves, hit /simulate, pay out
│   └── GET  /api/game/[id] → game state
└── Contracts
    ├── CommitReveal.sol  → secure randomness (commit before reveal)
    ├── GameTreasury.sol  → holds tokens, keeper pays out winners
    ├── GameToken.sol     → ERC-20 per game
    └── (future) IClawdGame.sol interface
```

---

## Game Types (from slop-computer-two research)

| Type | Input | Verified On-Chain | Trust |
|---|---|---|---|
| 1 | No | No | Trust keeper |
| 2 | Yes | No | Trust keeper |
| 3 | No | Yes (optimistic) | Challengeable |
| 4 | Yes | Yes (optimistic) | Challengeable |

**For the prototype: Type 2** — interactive game, keeper-trusted resolver. On-chain verification (Types 3/4) is a future upgrade.

---

## The CLAWD Flywheel (Future)

- Every game has its own token, paired with CLAWD on Uniswap v4
- 20% of all swap fees buy + burn CLAWD
- More games → more CLAWD burned → CLAWD scarcer → more prestigious to launch here
- Token launch via Flow Protocol (60-min CCA auction)

---

## Randomness: CommitReveal

The cleanest approach from slop-computer-two:

```
1. Facilitator commits: hash = keccak256(randomValue)  ← before player signs
2. Player signs tx (can't change the randomValue)
3. Next block: reveal(randomValue)
4. seed = keccak256(randomValue, blockhash(commitBlock))
```

Neither facilitator nor player can predict or manipulate the final seed.

---

## Open Questions

- Does the game dev self-host and just register a URL? → **Yes, for the proto**
- What's the token economic model for the proto? → TBD (possibly just MockGameToken for now)
- Does the platform host an example game (like lobster runner) to demo? → Probably yes
- What chain for the proto? → Local anvil first, then Base testnet / Base mainnet

---

## What to Build (Rough Order)

1. **Contracts**: CommitReveal + GameTreasury + MockGameToken
2. **Keeper API**: `/api/start` (charge + commit) and `/api/finish` (simulate + payout)
3. **SDK**: postMessage bridge, dev/test mode detection
4. **Platform shell**: game grid, iframe wrapper, top bar
5. **Example game**: lobster runner (already exists in proto) adapted to use SDK
6. **Token swap UI**: CLAWD → game token
