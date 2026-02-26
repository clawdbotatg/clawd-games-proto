"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { DeterministicDice } from "deterministic-dice";
import { LobsterRunner } from "~~/components/LobsterRunner";

// ---------------------------------------------------------------------------
// Constants — must match keeper + contract
// ---------------------------------------------------------------------------

const RUN_DURATION_MS  = 8000;
const JUMP_DURATION_MS = 800;
const OBSTACLE_COUNT   = 5;

interface SimResult {
  obstacles: number[];
  isWin:     boolean;
  cleared:   boolean[];
}

function runSimulate(seed: string, movesRaw: string): SimResult | null {
  if (!seed || !seed.startsWith("0x")) return null;
  try {
    const dice = new DeterministicDice(seed);
    const obstacles = Array.from({ length: OBSTACLE_COUNT }, () => dice.roll(100));
    const isWin     = dice.roll(10) === 0;

    const moves = movesRaw
      ? movesRaw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
      : [];

    const cleared = obstacles.map(obsPos => {
      const obstacleTime = (obsPos / 100) * RUN_DURATION_MS;
      return moves.some(t => t <= obstacleTime && t >= obstacleTime - JUMP_DURATION_MS);
    });

    return { obstacles, isWin, cleared };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inner (uses useSearchParams — needs Suspense wrapper)
// ---------------------------------------------------------------------------

function SimulateInner() {
  const searchParams  = useSearchParams();
  const seedFromUrl   = searchParams.get("seed") || "";
  const movesFromUrl  = searchParams.get("moves") || "";

  const [seed, setSeed]   = useState(seedFromUrl);
  const [moves, setMoves] = useState(movesFromUrl);
  const [result, setResult] = useState<SimResult | null>(
    seedFromUrl ? runSimulate(seedFromUrl, movesFromUrl) : null
  );
  const [replaying, setReplaying] = useState(false);

  const handleSimulate = () => {
    const r = runSimulate(seed, moves);
    setResult(r);
    setReplaying(false);
  };

  return (
    <main
      className="min-h-screen bg-black text-white p-6"
      style={{ fontFamily: "'Press Start 2P', monospace" }}
    >
      <div className="max-w-3xl mx-auto">
        <a href="/" className="text-xs text-gray-500 hover:text-gray-300 underline">← back</a>

        <h1 className="text-xl text-green-400 mt-4 mb-2">🔍 Simulate / Replay</h1>
        <p className="text-xs text-gray-500 mb-6">
          Enter a seed + moves to reproduce any run exactly. No trust required — pure deterministic math.
        </p>

        {/* Inputs */}
        <div className="border border-gray-700 rounded-lg p-4 mb-6 flex flex-col gap-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Seed (bytes32 from SeedFulfilled event)</label>
            <input
              type="text"
              value={seed}
              onChange={e => setSeed(e.target.value)}
              placeholder="0xabcdef..."
              className="w-full bg-gray-900 border border-gray-600 text-green-300 text-xs px-3 py-2 rounded font-mono"
            />
          </div>

          <div>
            <label className="text-xs text-gray-400 block mb-1">
              Moves (comma-separated jump timestamps in ms, optional)
            </label>
            <input
              type="text"
              value={moves}
              onChange={e => setMoves(e.target.value)}
              placeholder="1240,2800,4100,5500,7200"
              className="w-full bg-gray-900 border border-gray-600 text-yellow-300 text-xs px-3 py-2 rounded font-mono"
            />
          </div>

          <button
            onClick={handleSimulate}
            disabled={!seed}
            className="bg-green-800 hover:bg-green-700 border border-green-500 text-green-200 text-xs px-4 py-2 rounded disabled:opacity-40"
          >
            Run Simulate →
          </button>
        </div>

        {/* Results */}
        {result && (
          <div className="flex flex-col gap-4">
            {/* Outcome */}
            <div className={`border-2 rounded-lg p-4 text-center ${
              result.isWin
                ? "border-yellow-400 bg-yellow-950/20"
                : "border-red-600 bg-red-950/20"
            }`}>
              <div className={`text-2xl mb-2 ${result.isWin ? "text-yellow-400" : "text-red-400"}`}>
                {result.isWin ? "🎉 WIN" : "💀 LOSS"}
              </div>
              <div className="text-xs text-gray-400">
                dice.roll(10) → {result.isWin ? "0 (WIN)" : "1-9 (LOSS)"}
              </div>
            </div>

            {/* Obstacles */}
            <div className="border border-gray-700 rounded-lg p-4">
              <div className="text-xs text-gray-400 mb-3">OBSTACLE LAYOUT (0-99 track positions)</div>
              <div className="relative h-8 bg-gray-900 rounded mb-3">
                {result.obstacles.map((pos, i) => (
                  <div
                    key={i}
                    className={`absolute bottom-0 w-2 h-6 rounded-sm ${
                      result.cleared[i] ? "bg-green-500" : "bg-purple-500"
                    }`}
                    style={{ left: `${pos}%` }}
                    title={`Obstacle ${i + 1}: pos=${pos} ${result.cleared[i] ? "(cleared)" : "(hit)"}`}
                  />
                ))}
                <div className="absolute right-0 bottom-0 text-lg">📦</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {result.obstacles.map((pos, i) => (
                  <div
                    key={i}
                    className={`text-xs px-2 py-1 rounded border ${
                      result.cleared[i]
                        ? "border-green-600 text-green-400"
                        : "border-purple-600 text-purple-400"
                    }`}
                  >
                    #{i + 1}: pos={pos} {result.cleared[i] ? "✓" : "✗"}
                  </div>
                ))}
              </div>
            </div>

            {/* Verification note */}
            <div className="border border-gray-700 rounded-lg p-4 text-xs text-gray-500">
              <div className="mb-2 text-gray-400">HOW TO VERIFY</div>
              <div className="font-mono text-xs leading-relaxed">
                <div>const dice = new DeterministicDice(&quot;{seed.slice(0, 20)}...&quot;);</div>
                <div className="text-blue-400">
                  // Obstacles: {result.obstacles.map((_, i) => `dice.roll(100)=${result.obstacles[i]}`).join(", ")}
                </div>
                <div className={result.isWin ? "text-yellow-400" : "text-red-400"}>
                  // Loot box: dice.roll(10) === 0 → {String(result.isWin)}
                </div>
              </div>
            </div>

            {/* Replay button */}
            {!replaying && result.obstacles.length === 5 && (
              <button
                onClick={() => setReplaying(true)}
                className="border border-green-700 bg-green-950/30 text-green-400 text-xs px-4 py-3 rounded hover:bg-green-900/30"
              >
                🎮 Replay the run visually
              </button>
            )}

            {replaying && (
              <div className="border border-green-600 bg-gray-950 rounded-lg p-4">
                <LobsterRunner
                  seed={seed}
                  obstacles={result.obstacles}
                  isWin={result.isWin}
                  onRunComplete={() => {}} // no-op for replay
                />
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Exported page — Suspense boundary for useSearchParams
// ---------------------------------------------------------------------------

export default function SimulatePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black text-green-400 flex items-center justify-center" style={{ fontFamily: "'Press Start 2P'" }}>Loading...</div>}>
      <SimulateInner />
    </Suspense>
  );
}
