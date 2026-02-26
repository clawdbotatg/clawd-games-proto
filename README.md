# ClawdGames Proto 🎮🦞

A minimal working prototype of the [ClawdGames](https://clawdgames.xyz) platform.

**Run a lobster. Open a loot box. Win 9× or lose. All verifiable onchain.**

---

## Architecture

```
Player  →  commitPlay(commitment, betAmount)   → tokens locked
Keeper  →  fulfillSeed(player, keeperSecret)   → seed = keccak256(commitment || secret || blockNumber)
Frontend→  DeterministicDice(seed) → 5 obstacles + loot box outcome (roll(10)===0 → WIN)
Player  →  plays run, records moves[]
Keeper  →  simulate(seed, moves) → isWin → resolve(player, isWin) → payout
```

**Randomness**: Commit-reveal. Player commits first, keeper reveals after. Neither party knows the other's secret at commit time. Final seed = combination of both → neither can manipulate alone.

**Verifiability**: Any run can be replayed with just `seed + moves` at `/simulate`. No trust needed.

---

## Contracts

| Contract | Description |
|---|---|
| `MockGameToken` | Freely mintable ERC-20 (testnet only) |
| `LootBoxGame` | Main game: commit, fulfill, resolve |
| `GameTokenFeeSplitter` | 80% creator / 20% burn |
| `DeterministicDice` | Solidity port of [deterministic-dice](https://github.com/austintgriffith/deterministic-dice) |

**Win condition**: `DeterministicDice(seed).roll(100) × 5` (obstacles), then `roll(10) === 0` → WIN (9× payout, 0.9× EV)

---

## Quick Start

```bash
# 1. Install
yarn install

# 2. Start local chain (in separate terminal)
yarn chain

# 3. Deploy contracts
yarn deploy

# 4. Start keeper (in separate terminal)
cd packages/keeper && npm install && npm start

# 5. Start frontend
yarn start
```

Visit [http://localhost:3000](http://localhost:3000)

---

## Keeper Service

The keeper runs at `http://localhost:3001` and does two things:

1. **Watches** for `Committed` events → calls `fulfillSeed(player, randomSecret)`
2. **HTTP API**: `POST /resolve { playerAddress, seed, moves, betAmount }` → simulate → `resolve(player, isWin)`

```bash
cd packages/keeper
cp .env.example .env
npm start
```

---

## Simulate / Replay

Any run is publicly verifiable. Given a `seed` and `moves` array:

```ts
import { DeterministicDice } from "deterministic-dice";
const dice = new DeterministicDice(seed);
const obstacles = Array.from({length: 5}, () => dice.roll(100));
const isWin = dice.roll(10) === 0; // 1/10 chance
```

Visit `/simulate?seed=0x...&moves=1240,2800,4100` to replay any run visually.

---

## Security Notes

- No private keys in git. Keeper PK is **anvil test key only**.
- SafeERC20 for all token transfers.
- Checks-Effects-Interactions pattern throughout.
- Keeper is trusted for this prototype. Production: use a VRF or decentralized keeper.

---

## Stack

- **Contracts**: Solidity 0.8.19, Foundry, OpenZeppelin
- **Frontend**: Next.js, Wagmi, Viem, Scaffold-ETH 2
- **Keeper**: Node.js, Ethers v6, Express
- **Randomness lib**: [deterministic-dice](https://github.com/austintgriffith/deterministic-dice)
