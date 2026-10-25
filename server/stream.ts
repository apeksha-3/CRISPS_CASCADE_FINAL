// server/stream.ts
// Server-Sent Events: a plain HTTP response that stays open; the server writes
//   event: <name>\ndata: <json>\n\n
// and the browser's EventSource gets one message per block.
//
// Each open stream has a Player: it waits between steps (speed), and can be
// paused, resumed, stepped one tick while paused, or sped up from the dashboard.

import type { Request, Response } from "express";

export function openSse(res: Response): (event: string, data: unknown) => void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  return (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

// speed = ticks per second: 1 -> 1000 ms per tick, 4 -> 250 ms, 0 -> no wait at all.
export function parseSpeed(x: unknown, def = 1): number {
  const s = Number(x ?? def);
  return Number.isFinite(s) && s >= 0 && s <= 100 ? s : def;
}

export class Player {
  readonly id: string;
  speed: number;
  paused = false;
  closed = false;
  private steps = 0; // ticks allowed through while paused (the "next tick" key)
  private wake: (() => void) | undefined;

  constructor(id: string, speed: number) {
    this.id = id;
    this.speed = speed;
  }

  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
    this.poke();
  }
  step(): void {
    this.steps++;
    this.poke();
  }
  setSpeed(s: number): void {
    this.speed = s;
    this.poke();
  }
  close(): void {
    this.closed = true;
    this.poke();
  }

  private poke(): void {
    const w = this.wake;
    this.wake = undefined;
    w?.();
  }

  // Wait until the next tick may run. `unit` scales the delay (prior-shift episodes are shorter).
  async gate(unit = 1000): Promise<void> {
    if (this.speed > 0 && !this.paused) await this.sleep(unit / this.speed);
    while (this.paused && !this.closed) {
      if (this.steps > 0) {
        this.steps--;
        return;
      }
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        r();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        r();
      };
    });
  }
}

// All open streams, so POST /api/replay/pause etc. can find them.
export const players = new Map<string, Player>();
let counter = 0;

export function newPlayer(_req: Request, res: Response, speed: number, paused = false): Player {
  const p = new Player(`s${++counter}`, speed);
  p.paused = paused;
  players.set(p.id, p);
  const done = () => {
    p.close();
    players.delete(p.id);
  };
  res.on("close", done); // the browser closed the EventSource (or the stream ended)
  return p;
}

// The stream(s) a control request is for: ?id=s3, or every open stream when no id is given.
export function targets(id: unknown): Player[] {
  if (typeof id === "string" && id) return players.has(id) ? [players.get(id)!] : [];
  return [...players.values()];
}
