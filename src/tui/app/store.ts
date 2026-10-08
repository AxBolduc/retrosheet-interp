/**
 * Bridges the Effect world (the {@link Scorer} service running in a
 * ManagedRuntime) and React: a subscribable snapshot of the scorer state,
 * plus a way to run scorer effects from event handlers.
 */
import { Effect, Fiber, type Layer, ManagedRuntime, Stream } from "effect"
import { Scorer, type ScorerState } from "../Scorer.ts"

export interface ScorerStore {
  readonly getSnapshot: () => ScorerState
  readonly subscribe: (listener: () => void) => () => void
  /** Run an effect that uses the scorer; failures are returned as rejected promises. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, Scorer>) => Promise<A>
  readonly dispose: () => Promise<void>
}

export const makeScorerStore = async <E>(layer: Layer.Layer<Scorer, E>): Promise<ScorerStore> => {
  const runtime = ManagedRuntime.make(layer)
  const scorer = await runtime.runPromise(Scorer.useSync((s) => s))
  let snapshot = await runtime.runPromise(scorer.get)
  const listeners = new Set<() => void>()
  const fiber = runtime.runFork(
    Stream.runForEach(scorer.changes, (s) =>
      Effect.sync(() => {
        snapshot = s
        for (const l of listeners) l()
      }))
  )
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    run: (effect) => runtime.runPromise(effect),
    dispose: async () => {
      await runtime.runPromise(Fiber.interrupt(fiber))
      await runtime.dispose()
    }
  }
}
