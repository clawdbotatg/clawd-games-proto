"use client";

import { useEffect, useRef, useCallback, useState } from "react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CANVAS_WIDTH     = 800;
const CANVAS_HEIGHT    = 200;
const GROUND_Y         = 150;
const LOBSTER_X        = 80;
const LOBSTER_SIZE     = 40;
const RUN_DURATION_MS  = 8000;
const JUMP_DURATION_MS = 800;
const JUMP_HEIGHT      = 80;

interface Obstacle {
  position: number;    // 0-99
  x:        number;    // computed canvas x
  cleared:  boolean;
}

interface LobsterRunnerProps {
  seed:         string;            // bytes32 hex from oracle
  obstacles:    number[];          // 5 positions 0-99
  isWin:        boolean;           // loot box outcome (pre-computed from seed)
  onRunComplete: (moves: number[]) => void;  // called when lobster reaches loot box
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LobsterRunner({ seed: _seed, obstacles: obstaclePositions, isWin, onRunComplete }: LobsterRunnerProps) {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const startTimeRef  = useRef<number>(0);
  const movesRef      = useRef<number[]>([]);
  const rafRef        = useRef<number>(0);
  const jumpRef       = useRef<{ active: boolean; start: number }>({ active: false, start: 0 });
  const completedRef  = useRef(false);

  const [phase, setPhase] = useState<"running" | "lootbox" | "done">("running");
  const [showResult, setShowResult] = useState(false);

  // Convert positions 0-99 → canvas x coords (leaving room for loot box)
  const LOOT_BOX_X = CANVAS_WIDTH - 80;
  const obstacles: Obstacle[] = obstaclePositions.map(pos => ({
    position: pos,
    x: LOBSTER_X + 60 + (pos / 100) * (LOOT_BOX_X - LOBSTER_X - 120),
    cleared: false,
  }));

  // ---------------------------------------------------------------------------
  // Jump handler
  // ---------------------------------------------------------------------------

  const handleJump = useCallback(() => {
    if (completedRef.current) return;
    if (jumpRef.current.active) return;
    const now = Date.now() - startTimeRef.current;
    jumpRef.current = { active: true, start: now };
    movesRef.current.push(now);
  }, []);

  // ---------------------------------------------------------------------------
  // Keyboard handler
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        handleJump();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleJump]);

  // ---------------------------------------------------------------------------
  // Draw helpers
  // ---------------------------------------------------------------------------

  function drawGround(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "#0f3";
    ctx.fillRect(0, GROUND_Y, CANVAS_WIDTH, 4);
    ctx.fillStyle = "#0a2";
    ctx.fillRect(0, GROUND_Y + 4, CANVAS_WIDTH, CANVAS_HEIGHT - GROUND_Y - 4);
  }

  function drawLobster(ctx: CanvasRenderingContext2D, y: number) {
    ctx.font = `${LOBSTER_SIZE}px serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("🦞", LOBSTER_X, y);
  }

  function drawObstacles(ctx: CanvasRenderingContext2D, progress: number) {
    obstacles.forEach((obs) => {
      const relX = obs.x - progress * CANVAS_WIDTH;
      if (relX < -40 || relX > CANVAS_WIDTH + 10) return;

      const h = 48;
      // Glowing neon obstacle
      ctx.shadowColor = "#f0f";
      ctx.shadowBlur  = 10;
      ctx.fillStyle   = "#c0f";
      ctx.fillRect(relX - 15, GROUND_Y - h, 30, h);
      ctx.shadowBlur  = 0;

      // Danger stripes
      ctx.fillStyle = "#f0f";
      ctx.fillRect(relX - 15, GROUND_Y - 8, 30, 8);
    });
  }

  function drawLootBox(ctx: CanvasRenderingContext2D, progress: number) {
    const relX = LOOT_BOX_X - progress * CANVAS_WIDTH;
    ctx.font = "48px serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";

    // Pulsing glow
    const t = Date.now() % 1000 / 1000;
    ctx.shadowColor = "#ff0";
    ctx.shadowBlur  = 15 + Math.sin(t * Math.PI * 2) * 10;
    ctx.fillText("📦", relX, GROUND_Y);
    ctx.shadowBlur  = 0;
  }

  function getLobsterY(now: number): number {
    if (!jumpRef.current.active) return GROUND_Y - LOBSTER_SIZE * 0.4;
    const elapsed = now - jumpRef.current.start;
    if (elapsed > JUMP_DURATION_MS) {
      jumpRef.current.active = false;
      return GROUND_Y - LOBSTER_SIZE * 0.4;
    }
    const t = elapsed / JUMP_DURATION_MS;
    const h = Math.sin(t * Math.PI) * JUMP_HEIGHT;
    return GROUND_Y - LOBSTER_SIZE * 0.4 - h;
  }

  // ---------------------------------------------------------------------------
  // Animation loop
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    startTimeRef.current = Date.now();
    movesRef.current     = [];
    completedRef.current = false;

    function draw() {
      if (!ctx) return;
      const now      = Date.now() - startTimeRef.current;
      const progress = Math.min(now / RUN_DURATION_MS, 1);

      // Background
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Stars
      ctx.fillStyle = "#ffffff44";
      for (let i = 0; i < 20; i++) {
        const sx = ((i * 137 + now * 0.02) % CANVAS_WIDTH);
        ctx.fillRect(sx, (i * 47) % (GROUND_Y - 20), 2, 2);
      }

      drawGround(ctx);
      drawObstacles(ctx, progress * 0.3);  // parallax scroll
      drawLootBox(ctx, progress * 0.3);

      const lobsterY = getLobsterY(now);
      drawLobster(ctx, lobsterY);

      // HUD
      ctx.fillStyle = "#0f0";
      ctx.font      = "10px 'Press Start 2P', monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(`JUMPS: ${movesRef.current.length}`, 10, 10);
      ctx.fillStyle = "#ff0";
      ctx.fillText("SPACE to jump!", CANVAS_WIDTH / 2 - 70, 10);

      // Progress bar
      ctx.fillStyle = "#333";
      ctx.fillRect(10, CANVAS_HEIGHT - 20, CANVAS_WIDTH - 20, 8);
      ctx.fillStyle = "#0f0";
      ctx.fillRect(10, CANVAS_HEIGHT - 20, (CANVAS_WIDTH - 20) * progress, 8);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(draw);
      } else {
        // Reached loot box
        completedRef.current = true;
        setPhase("lootbox");
        setTimeout(() => {
          setShowResult(true);
          setPhase("done");
          onRunComplete(movesRef.current);
        }, 1500);
      }
    }

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [obstaclePositions]);

  // ---------------------------------------------------------------------------
  // Loot box open animation
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (phase !== "lootbox") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    function animateLootBox() {
      if (!ctx) return;
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      ctx.font         = "80px serif";
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";

      const scale = 1 + Math.sin(frame / 5) * 0.1;
      ctx.save();
      ctx.translate(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
      ctx.scale(scale, scale);
      ctx.fillText("📦", 0, 0);
      ctx.restore();

      frame++;
      if (frame < 45) {
        requestAnimationFrame(animateLootBox);
      } else {
        // Show open state
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        ctx.font      = "80px serif";
        ctx.fillText(isWin ? "🎉" : "💀", CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
      }
    }
    requestAnimationFrame(animateLootBox);
  }, [phase, isWin]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative">
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          className="rounded-lg border-2 border-green-500 cursor-pointer"
          style={{ imageRendering: "pixelated" }}
          onClick={handleJump}
        />
        {phase === "running" && (
          <div
            className="absolute bottom-8 left-1/2 -translate-x-1/2 text-xs text-green-400 animate-pulse"
            style={{ fontFamily: "'Press Start 2P', monospace" }}
          >
            SPACE / TAP to jump
          </div>
        )}
      </div>

      {showResult && (
        <div
          className={`text-center p-6 rounded-xl border-2 ${
            isWin
              ? "border-yellow-400 bg-yellow-900/30 text-yellow-400"
              : "border-red-500 bg-red-900/30 text-red-400"
          }`}
          style={{ fontFamily: "'Press Start 2P', monospace" }}
        >
          {isWin ? (
            <div>
              <div className="text-2xl mb-2">🎉 YOU WIN! 🎉</div>
              <div className="text-sm">LOOT BOX UNLOCKED</div>
              <div className="text-lg mt-2 text-yellow-300">+900 GAME per 100 bet</div>
            </div>
          ) : (
            <div>
              <div className="text-2xl mb-2">💀 EMPTY BOX 💀</div>
              <div className="text-sm text-red-300">Better luck next run</div>
            </div>
          )}
        </div>
      )}

      <div
        className="text-xs text-gray-500 text-center max-w-md"
        style={{ fontFamily: "'Press Start 2P', monospace", fontSize: "8px" }}
      >
        Obstacles derived from seed · Loot box: 1/10 chance · Verifiable on-chain
      </div>
    </div>
  );
}
