// Stand-in provider until DAT access is approved: a realistic generated board
// per company that keeps changing between refreshes (loads get covered, new
// ones get posted), searched the same way a real board would be.

import { createHash } from "node:crypto";
import { roadMiles } from "../../src/engine/geo";
import { churnLoadBoard, makeLoadBoard, rng } from "../../src/engine/synthetic";
import type { Load } from "../../src/engine/types";
import type { LoadSearch, LoadSource, SourceLoad } from "./source";

interface OrgBoard {
  board: Load[];
  rand: () => number;
  churnedAt: number;
}

export class SyntheticLoadSource implements LoadSource {
  readonly name = "synthetic" as const;
  private boards = new Map<string, OrgBoard>();

  /** `churnEveryMs`: how often the simulated board moves. `now` is injectable for tests. */
  constructor(private churnEveryMs = 60_000, private now: () => number = Date.now, private size = 2500) {}

  async search(orgId: string, q: LoadSearch): Promise<SourceLoad[]> {
    const board = this.boardFor(orgId);
    return board
      .filter((l) =>
        l.equipment === q.equipment &&
        l.pickupEarliest <= q.pickupTo &&
        l.pickupLatest >= q.pickupFrom &&
        roadMiles(q.origin, l.origin) <= q.radiusMiles)
      .map(({ id: _id, ...rest }) => rest);
  }

  private boardFor(orgId: string): Load[] {
    const t = this.now();
    let entry = this.boards.get(orgId);
    if (!entry) {
      const seed = createHash("sha256").update(orgId).digest().readUInt32LE(0);
      entry = { board: makeLoadBoard(seed, t, this.size), rand: rng(seed ^ 0x9e3779b9), churnedAt: t };
      this.boards.set(orgId, entry);
    } else if (t - entry.churnedAt >= this.churnEveryMs) {
      entry.board = churnLoadBoard(entry.board, entry.rand, t);
      entry.churnedAt = t;
    }
    return entry.board;
  }
}
