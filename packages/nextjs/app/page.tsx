"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount } from "wagmi";
import { keccak256, encodePacked, formatEther, parseEther } from "viem";
import { DeterministicDice } from "deterministic-dice";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth/useScaffoldReadContract";
import { useScaffoldWriteContract } from "~~/hooks/scaffold-eth/useScaffoldWriteContract";
import { useScaffoldWatchContractEvent } from "~~/hooks/scaffold-eth/useScaffoldWatchContractEvent";
import { useDeployedContractInfo } from "~~/hooks/scaffold-eth/useDeployedContractInfo";
import { LobsterRunner } from "~~/components/LobsterRunner";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEEPER_API = process.env.NEXT_PUBLIC_KEEPER_URL || "http://localhost:3001";

type GamePhase =
  | "idle"
  | "approving"
  | "committing"
  | "waiting_seed"
  | "playing"
  | "resolving"
  | "win"
  | "loss";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ClawdGamesPage() {
  const { address, isConnected } = useAccount();

  // ─── UI State ───────────────────────────────────────────────────────────
  const [betInput, setBetInput]       = useState("100");
  const [phase, setPhase]             = useState<GamePhase>("idle");
  const [statusMsg, setStatusMsg]     = useState("");
  const [finalSeed, setFinalSeed]     = useState<`0x${string}` | null>(null);
  const [obstacles, setObstacles]     = useState<number[]>([]);
  const [isWin, setIsWin]             = useState(false);
  const [payout, setPayout]           = useState<bigint>(0n);
  const [recentRuns, setRecentRuns]   = useState<
    Array<{ seed: string; betAmount: string; isWin: boolean; payout: string; ts: number }>
  >([]);

  // Store player secret between steps
  const playerSecretRef = useRef<`0x${string}` | null>(null);
  const betAmountRef    = useRef<bigint>(0n);

  // ─── Contract Reads ─────────────────────────────────────────────────────

  const { data: gameBalance, refetch: refetchBalance } = useScaffoldReadContract({
    contractName: "MockGameToken",
    functionName: "balanceOf",
    args:         [address ?? "0x0000000000000000000000000000000000000000"],
    watch:        true,
  });

  const { data: prizePool } = useScaffoldReadContract({
    contractName: "LootBoxGame",
    functionName: "prizePool",
    watch:        true,
  });

  const { data: lootBoxContractInfo } = useDeployedContractInfo({ contractName: "LootBoxGame" });

  // ─── Contract Writes ────────────────────────────────────────────────────

  const { writeContractAsync: writeMint }      = useScaffoldWriteContract({ contractName: "MockGameToken" });
  const { writeContractAsync: writeApprove }   = useScaffoldWriteContract({ contractName: "MockGameToken" });
  const { writeContractAsync: writeCommit }    = useScaffoldWriteContract({ contractName: "LootBoxGame" });

  // ─── Watch Events ────────────────────────────────────────────────────────

  useScaffoldWatchContractEvent({
    contractName: "LootBoxGame",
    eventName:    "SeedFulfilled",
    onLogs: (logs) => {
      for (const log of logs) {
        const logAny = log as unknown as { args: { player: string; finalSeed: `0x${string}` } };
        if (logAny.args?.player?.toLowerCase() === address?.toLowerCase()) {
          const seed = logAny.args.finalSeed;
          console.log("[game] SeedFulfilled:", seed);
          setFinalSeed(seed);

          // Derive obstacles and outcome from seed
          const dice      = new DeterministicDice(seed);
          const obs       = Array.from({ length: 5 }, () => dice.roll(100));
          const winResult = dice.roll(10) === 0;

          setObstacles(obs);
          setIsWin(winResult);
          setPhase("playing");
          setStatusMsg("Seed revealed! Run lobster run! 🦞");
        }
      }
    },
  });

  useScaffoldWatchContractEvent({
    contractName: "LootBoxGame",
    eventName:    "RunCompleted",
    onLogs: (logs) => {
      for (const log of logs) {
        const logAny = log as unknown as {
          args: { player: string; finalSeed: string; betAmount: bigint; isWin: boolean; payout: bigint }
        };
        if (logAny.args?.player?.toLowerCase() === address?.toLowerCase()) {
          const { isWin: won, payout: p, betAmount: bet, finalSeed: s } = logAny.args;
          setPayout(p);
          setPhase(won ? "win" : "loss");
          setStatusMsg(won ? "🎉 LOOT BOX OPENED! YOU WIN!" : "💀 Empty box. Try again.");

          // Add to recent runs
          setRecentRuns(prev => [{
            seed:      s,
            betAmount: bet.toString(),
            isWin:     won,
            payout:    p.toString(),
            ts:        Date.now(),
          }, ...prev.slice(0, 4)]);

          refetchBalance();
        }
      }
    },
  });

  // ─── Handlers ────────────────────────────────────────────────────────────

  const handleMint = async () => {
    if (!address) return;
    try {
      setStatusMsg("Minting 1000 GAME...");
      await writeMint({ functionName: "mint", args: [address, parseEther("1000")] });
      setStatusMsg("✅ Minted 1000 GAME");
      refetchBalance();
    } catch (e) {
      setStatusMsg("Mint failed");
      console.error(e);
    }
  };

  const handleStartRun = async () => {
    if (!address || !isConnected) return;

    const betWei = parseEther(betInput || "100");
    betAmountRef.current = betWei;

    // Generate random player secret
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const secret = ("0x" + Array.from(randomBytes).map(b => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
    playerSecretRef.current = secret;

    // Compute commitment
    const commitment = keccak256(encodePacked(["bytes32", "uint256"], [secret, betWei]));

    try {
      // Step 1: Approve
      setPhase("approving");
      setStatusMsg("Step 1/2: Approve GAME tokens...");

      // Get LootBoxGame address from deployed contracts
      const lootBoxAddress = lootBoxContractInfo?.address ?? "0xA15BB66138824a1c7167f5E85b957d04Dd34E468";

      await writeApprove({
        functionName: "approve",
        args:         [lootBoxAddress as `0x${string}`, betWei],
      });

      // Step 2: Commit
      setPhase("committing");
      setStatusMsg("Step 2/2: Locking bet + commitment...");
      await writeCommit({
        functionName: "commitPlay",
        args:         [commitment, betWei],
      });

      setPhase("waiting_seed");
      setStatusMsg("⏳ Waiting for keeper to reveal seed...");
    } catch (e) {
      setPhase("idle");
      setStatusMsg("Transaction failed. Try again.");
      console.error(e);
    }
  };

  const handleRunComplete = useCallback(async (moves: number[]) => {
    if (!address || !finalSeed) return;
    setPhase("resolving");
    setStatusMsg("🔒 Submitting run to keeper...");

    try {
      const res = await fetch(`${KEEPER_API}/resolve`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerAddress: address,
          seed:          finalSeed,
          moves,
          betAmount:     betAmountRef.current.toString(),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Keeper resolve failed");
      }

      setStatusMsg("⏳ Waiting for on-chain confirmation...");
      // RunCompleted event watcher will update phase
    } catch (e) {
      setStatusMsg(`Resolve failed: ${(e as Error).message}`);
      setPhase("idle");
    }
  }, [address, finalSeed]);

  const handleReset = () => {
    setPhase("idle");
    setFinalSeed(null);
    setObstacles([]);
    setIsWin(false);
    setPayout(0n);
    setStatusMsg("");
    playerSecretRef.current = null;
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  const balanceFormatted = gameBalance ? parseFloat(formatEther(gameBalance as bigint)).toFixed(1) : "0.0";
  const prizePoolFormatted = prizePool ? parseFloat(formatEther(prizePool as bigint)).toFixed(0) : "0";
  const betWei = parseEther(betInput || "100");

  return (
    <main
      className="min-h-screen bg-black text-white"
      style={{ fontFamily: "'Press Start 2P', monospace" }}
    >
      {/* ── Header ── */}
      <div className="border-b-2 border-green-500 bg-black py-6 px-4 text-center">
        <h1 className="text-2xl text-green-400 mb-1">ClawdGames Proto 🎮</h1>
        <p className="text-xs text-gray-400">Onchain loot box · commit-reveal fairness · 1/10 chance · 9x payout</p>
        <div className="text-xs text-yellow-400 mt-2">Prize Pool: {prizePoolFormatted} GAME</div>
      </div>

      <div className="max-w-4xl mx-auto p-4 flex flex-col gap-6">

        {/* ── Wallet not connected ── */}
        {!isConnected && (
          <div className="text-center py-12 text-gray-400">
            <div className="text-xl mb-4">🦞</div>
            <div className="text-sm">Connect wallet to play</div>
          </div>
        )}

        {isConnected && (
          <>
            {/* ── Balance ── */}
            <div className="border border-green-800 bg-green-950/20 rounded-lg p-4 flex items-center justify-between">
              <div>
                <div className="text-xs text-green-400 mb-1">GAME Balance</div>
                <div className="text-xl text-green-300">{balanceFormatted} GAME</div>
              </div>
              <button
                onClick={handleMint}
                disabled={phase !== "idle" && phase !== "win" && phase !== "loss"}
                className="bg-green-800 hover:bg-green-700 text-green-200 text-xs px-4 py-2 rounded border border-green-600 disabled:opacity-50"
              >
                Mint 1000 GAME
              </button>
            </div>

            {/* ── Game Section ── */}
            {(phase === "idle" || phase === "win" || phase === "loss") && (
              <div className="border border-yellow-700 bg-yellow-950/10 rounded-lg p-4">
                <div className="text-xs text-yellow-400 mb-4">THE LOOT BOX RUN</div>

                <div className="flex gap-3 items-center mb-4">
                  <div className="text-xs text-gray-400">BET:</div>
                  <input
                    type="number"
                    value={betInput}
                    onChange={e => setBetInput(e.target.value)}
                    className="bg-black border border-yellow-600 text-yellow-300 text-sm px-3 py-2 rounded w-32"
                    min="1"
                    placeholder="100"
                  />
                  <div className="text-xs text-gray-500">GAME</div>
                  <div className="text-xs text-gray-400 ml-auto">
                    Win: {(parseFloat(betInput || "0") * 9).toFixed(1)} GAME (1/10 chance)
                  </div>
                </div>

                {phase === "win" && (
                  <div className="mb-4 p-3 bg-yellow-900/40 border border-yellow-400 rounded text-center">
                    <div className="text-yellow-300 text-lg">🎉 +{parseFloat(formatEther(payout)).toFixed(1)} GAME!</div>
                  </div>
                )}
                {phase === "loss" && (
                  <div className="mb-4 p-3 bg-red-900/30 border border-red-600 rounded text-center">
                    <div className="text-red-400 text-sm">💀 Box was empty. -{betInput} GAME</div>
                  </div>
                )}

                <button
                  onClick={phase === "idle" ? handleStartRun : handleReset}
                  disabled={!betInput || parseFloat(betInput) <= 0}
                  className={`w-full py-3 rounded text-sm border-2 transition-all ${
                    phase === "idle"
                      ? "bg-yellow-600 hover:bg-yellow-500 border-yellow-400 text-black"
                      : "bg-gray-800 hover:bg-gray-700 border-gray-600 text-gray-300"
                  } disabled:opacity-50`}
                >
                  {phase === "idle" ? "🦞 START RUN →" : "← PLAY AGAIN"}
                </button>
              </div>
            )}

            {/* ── Flow Steps ── */}
            {(phase === "approving" || phase === "committing" || phase === "waiting_seed") && (
              <div className="border border-blue-700 bg-blue-950/20 rounded-lg p-4">
                <div className="flex justify-between mb-4 text-xs">
                  <div className={`px-2 py-1 rounded ${phase === "approving" ? "bg-blue-600 text-white" : "text-gray-500"}`}>
                    1. Approve
                  </div>
                  <div className="text-gray-600">→</div>
                  <div className={`px-2 py-1 rounded ${phase === "committing" ? "bg-blue-600 text-white" : "text-gray-500"}`}>
                    2. Commit
                  </div>
                  <div className="text-gray-600">→</div>
                  <div className={`px-2 py-1 rounded ${phase === "waiting_seed" ? "bg-yellow-600 text-yellow-100 animate-pulse" : "text-gray-500"}`}>
                    3. Keeper reveals
                  </div>
                </div>
                <div className="text-center text-xs text-blue-300 animate-pulse">{statusMsg}</div>
              </div>
            )}

            {/* ── Runner Game ── */}
            {phase === "playing" && finalSeed && obstacles.length === 5 && (
              <div className="border border-green-600 bg-gray-950 rounded-lg p-4">
                <div className="text-xs text-green-400 mb-3 text-center">🦞 THE RUN IS ON! Jump with SPACE or TAP!</div>
                <LobsterRunner
                  seed={finalSeed}
                  obstacles={obstacles}
                  isWin={isWin}
                  onRunComplete={handleRunComplete}
                />
              </div>
            )}

            {/* ── Resolving ── */}
            {phase === "resolving" && (
              <div className="border border-purple-700 bg-purple-950/20 rounded-lg p-4 text-center">
                <div className="text-2xl mb-3 animate-bounce">📦</div>
                <div className="text-xs text-purple-300 animate-pulse">{statusMsg}</div>
              </div>
            )}

            {/* ── Status message ── */}
            {statusMsg && phase !== "idle" && phase !== "playing" && phase !== "resolving" && (
              <div className="text-xs text-center text-gray-400">{statusMsg}</div>
            )}

            {/* ── Recent Runs ── */}
            {recentRuns.length > 0 && (
              <div className="border border-gray-700 rounded-lg p-4">
                <div className="text-xs text-gray-400 mb-3">RECENT RUNS</div>
                <div className="flex flex-col gap-2">
                  {recentRuns.map((run, i) => (
                    <div key={i} className={`flex items-center justify-between text-xs p-2 rounded border ${
                      run.isWin ? "border-yellow-700 bg-yellow-950/20" : "border-red-800 bg-red-950/20"
                    }`}>
                      <div className={run.isWin ? "text-yellow-400" : "text-red-400"}>
                        {run.isWin ? "🎉 WIN" : "💀 LOSS"}
                      </div>
                      <div className="text-gray-500 text-right" style={{ fontSize: "8px" }}>
                        {run.seed.slice(0, 10)}...
                      </div>
                      <div className={run.isWin ? "text-yellow-300" : "text-red-400"}>
                        {run.isWin
                          ? `+${parseFloat(formatEther(BigInt(run.payout))).toFixed(1)}`
                          : `-${parseFloat(formatEther(BigInt(run.betAmount))).toFixed(1)}`
                        } GAME
                      </div>
                      <a
                        href={`/simulate?seed=${run.seed}`}
                        className="text-blue-500 hover:text-blue-400 underline ml-2"
                        style={{ fontSize: "8px" }}
                      >
                        replay
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Footer links ── */}
            <div className="flex gap-4 justify-center text-xs text-gray-600 pb-8">
              <a href="/simulate" className="hover:text-gray-400 underline">🔍 Simulate/Replay</a>
              <span>·</span>
              <a href="/debug" className="hover:text-gray-400 underline">🔧 Debug Contracts</a>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
