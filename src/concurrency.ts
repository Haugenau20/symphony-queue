/**
 * The shared concurrency gate between the implementation and review
 * controllers (design §6).
 *
 * Two independent controllers, each with its own poll loop, coordinate
 * through exactly one shared object. It enforces three things at once:
 *
 *   1. A hard global ceiling across both lanes.
 *   2. A per-lane ceiling.
 *   3. A reserved floor: slots the OTHER lane may never take, so that one
 *      lane saturating the global ceiling can never starve the other.
 *
 * `globalMax` is fixed at construction (per the frozen signature in design
 * §6). Each lane's own ceiling and reserved floor are not constructor
 * arguments — they are supplied on every `tryAcquire` call, because they are
 * that *lane's* configuration, not the gate's. The gate remembers the most
 * recently declared reserved floor for each lane (updated on every call,
 * granted or not) so that a lane which has never yet asked for a slot is
 * still protected once it does. In real operation both controllers tick
 * continuously and pass their configured `laneReserved` on every attempt, so
 * the reserved floor is registered well before it would ever need to bind.
 *
 * Reserved capacity is what prevents starvation. Without it, a handful of
 * long implementation runs could hold every global slot for hours while
 * merge requests pile up unreviewed (exactly the failure mode
 * `orchestrator.ts`'s `tick()` has today, breaking dispatch the instant
 * global slots are exhausted). Giving review a reserved floor means
 * implementation can never consume review's last protected slot.
 */

export type ConcurrencyLane = 'implementation' | 'review'

export interface Lease {
  /** Releases the slot. Safe to call more than once — the second call is a no-op. */
  release(): void
}

const OTHER_LANE: Record<ConcurrencyLane, ConcurrencyLane> = {
  implementation: 'review',
  review: 'implementation',
}

export class ConcurrencyGate {
  private readonly globalMax: number
  private readonly inUse: Record<ConcurrencyLane, number> = { implementation: 0, review: 0 }
  /** Last-declared reserved floor per lane, defaulting to 0 for a lane that has never called. */
  private readonly reserved: Record<ConcurrencyLane, number> = { implementation: 0, review: 0 }

  constructor(globalMax: number) {
    this.globalMax = globalMax
  }

  /**
   * Grants a lease when, and only when:
   *   - globalInUse < globalMax
   *   - AND laneInUse < laneMax
   *   - AND granting this slot still leaves the OTHER lane's reserved floor
   *     satisfiable (i.e. enough global headroom remains for the other lane
   *     to reach the number of slots it has declared as reserved).
   *
   * `laneReserved` is recorded as this lane's current floor before the grant
   * decision is made, whether or not the grant succeeds — a lane declares its
   * requirement simply by asking.
   */
  tryAcquire(lane: ConcurrencyLane, laneMax: number, laneReserved: number): Lease | null {
    this.reserved[lane] = laneReserved

    const other = OTHER_LANE[lane]
    const globalInUse = this.inUse.implementation + this.inUse.review

    if (globalInUse >= this.globalMax) return null
    if (this.inUse[lane] >= laneMax) return null

    const globalInUseAfterGrant = globalInUse + 1
    const otherStillNeeds = Math.max(0, this.reserved[other] - this.inUse[other])
    const headroomAfterGrant = this.globalMax - globalInUseAfterGrant
    if (headroomAfterGrant < otherStillNeeds) return null

    this.inUse[lane]++
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.inUse[lane]--
      },
    }
  }
}
