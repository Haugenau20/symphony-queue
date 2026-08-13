import { describe, it, expect } from 'vitest'
import { ConcurrencyGate } from '../src/concurrency.js'

describe('ConcurrencyGate — global ceiling', () => {
  it('grants up to globalMax leases and denies the one after', () => {
    const gate = new ConcurrencyGate(2)
    const a = gate.tryAcquire('implementation', 10, 0)
    const b = gate.tryAcquire('implementation', 10, 0)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    const c = gate.tryAcquire('implementation', 10, 0)
    expect(c).toBeNull()
  })

  it('releasing frees a global slot for a later acquire', () => {
    const gate = new ConcurrencyGate(1)
    const a = gate.tryAcquire('review', 10, 0)
    expect(a).not.toBeNull()
    expect(gate.tryAcquire('review', 10, 0)).toBeNull()
    a!.release()
    expect(gate.tryAcquire('review', 10, 0)).not.toBeNull()
  })

  it('releasing a lease twice is safe and only frees one slot', () => {
    const gate = new ConcurrencyGate(1)
    const a = gate.tryAcquire('review', 10, 0)!
    a.release()
    a.release() // must not throw, and must not free a second, nonexistent slot
    const b = gate.tryAcquire('review', 10, 0)
    expect(b).not.toBeNull()
    // Global capacity is still 1: a second acquire attempt while b is held must fail.
    expect(gate.tryAcquire('review', 10, 0)).toBeNull()
  })
})

describe('ConcurrencyGate — per-lane ceiling', () => {
  it('denies a lane once its own laneMax is reached, even with global headroom', () => {
    const gate = new ConcurrencyGate(10)
    const a = gate.tryAcquire('review', 1, 0)
    expect(a).not.toBeNull()
    const b = gate.tryAcquire('review', 1, 0)
    expect(b).toBeNull() // review's own laneMax=1 is exhausted
    // Global capacity is nowhere near exhausted — implementation can still acquire.
    const c = gate.tryAcquire('implementation', 10, 0)
    expect(c).not.toBeNull()
  })

  it('lanes are tracked independently: releasing implementation does not free review capacity', () => {
    const gate = new ConcurrencyGate(10)
    const impl = gate.tryAcquire('implementation', 1, 0)!
    expect(gate.tryAcquire('review', 1, 0)).not.toBeNull()
    expect(gate.tryAcquire('review', 1, 0)).toBeNull() // review's own laneMax=1
    impl.release()
    expect(gate.tryAcquire('review', 1, 0)).toBeNull() // still exhausted — impl's release didn't touch review
  })
})

describe('ConcurrencyGate — reserved floor (starvation prevention)', () => {
  it('STARVATION TEST: implementation saturating the gate still leaves review its reserved slot', () => {
    const globalMax = 3
    const gate = new ConcurrencyGate(globalMax)

    // Review declares its reserved floor of 1 by asking once, exactly as the
    // real review controller does on every tick — this is how the gate comes
    // to know review's floor before implementation has a chance to saturate.
    const reviewLease = gate.tryAcquire('review', /* laneMax */ 3, /* laneReserved */ 1)
    expect(reviewLease).not.toBeNull()
    reviewLease!.release() // give the slot back; only the *declaration* of reserved=1 needs to persist

    // Implementation now tries to fill the whole global ceiling, declaring no
    // reserved floor of its own (matches design §13's example config, which
    // has no implementation_reserved).
    const implLeases = []
    for (let i = 0; i < globalMax; i++) {
      implLeases.push(gate.tryAcquire('implementation', /* laneMax */ globalMax, /* laneReserved */ 0))
    }

    // globalMax=3, review's reserved floor is 1, so implementation must be
    // capped at 2 concurrent leases — the third attempt must be refused to
    // keep review's floor satisfiable.
    const grantedCount = implLeases.filter((l) => l !== null).length
    expect(grantedCount).toBe(globalMax - 1)
    expect(implLeases[implLeases.length - 1]).toBeNull()

    // The point of the reserved floor: review can still acquire a slot even
    // though implementation just tried to take everything.
    const reviewAfter = gate.tryAcquire('review', 3, 1)
    expect(reviewAfter).not.toBeNull()

    // And with review's reserved slot now actually in use, global capacity is
    // fully accounted for: no one else can acquire.
    expect(gate.tryAcquire('implementation', globalMax, 0)).toBeNull()
    expect(gate.tryAcquire('review', 3, 1)).toBeNull()
  })

  it('a lane may still consume its own reserved floor freely — reservation only restricts the OTHER lane', () => {
    const gate = new ConcurrencyGate(3)
    // Review declares reserved=2 but is not itself blocked from taking both of its own reserved slots.
    const r1 = gate.tryAcquire('review', 3, 2)
    const r2 = gate.tryAcquire('review', 3, 2)
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
  })

  it('once the reserved lane is holding fewer than its floor, the other lane is blocked from taking the difference', () => {
    const gate = new ConcurrencyGate(4)
    // Register review's reserved floor of 2.
    const priming = gate.tryAcquire('review', 4, 2)!
    priming.release()

    // Implementation may take up to globalMax - reviewReserved = 2 slots.
    const i1 = gate.tryAcquire('implementation', 4, 0)
    const i2 = gate.tryAcquire('implementation', 4, 0)
    const i3 = gate.tryAcquire('implementation', 4, 0)
    expect(i1).not.toBeNull()
    expect(i2).not.toBeNull()
    // A third grant would leave only 1 free global slot, but review's
    // registered floor of 2 (currently 0 in use) still needs 2 — refused.
    expect(i3).toBeNull()
  })

  it('a saboteur who ignores the other lane\'s reserved floor is caught: implementation cannot be blocked without it', () => {
    // This test exists to make the sabotage-resistance explicit: if the
    // reserved-floor check were removed (or always treated as satisfied),
    // implementation would be able to acquire globalMax leases outright.
    const globalMax = 3
    const gate = new ConcurrencyGate(globalMax)
    const priming = gate.tryAcquire('review', 3, 1)!
    priming.release()

    let granted = 0
    for (let i = 0; i < globalMax; i++) {
      if (gate.tryAcquire('implementation', globalMax, 0)) granted++
    }
    expect(granted).toBeLessThan(globalMax)
    expect(granted).toBe(globalMax - 1)
  })
})

describe('ConcurrencyGate — separate-container deployment (design §6)', () => {
  it('cross-lane logic is inert when only one lane is ever used: the lane can reach globalMax on its own', () => {
    const gate = new ConcurrencyGate(2)
    const a = gate.tryAcquire('review', 2, 0)
    const b = gate.tryAcquire('review', 2, 0)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(gate.tryAcquire('review', 2, 0)).toBeNull()
  })
})
