/**
 * The terminal app: the setup screen until a game is under way, then the scoring screen.
 */
import { useRenderer } from "@opentui/react"
import { useEffect, useState, useSyncExternalStore } from "react"
import { currentGame } from "../Scorer.ts"
import { ScoringScreen } from "./ScoringScreen.tsx"
import { SetupScreen } from "./SetupScreen.tsx"
import type { ScorerStore } from "./store.ts"

export interface AppProps {
  readonly store: ScorerStore
  /** Directory to autosave new games in (undefined: don't autosave). */
  readonly autosaveDir: string | undefined
  readonly onQuit: () => void
}

export const App = ({ store, autosaveDir, onQuit }: AppProps) => {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [screen, setScreen] = useState<"setup" | "scoring">(() => (currentGame(state) === undefined ? "setup" : "scoring"))
  const renderer = useRenderer()

  useEffect(() => {
    if (state.quit) onQuit()
  }, [state.quit, onQuit])

  useEffect(() => {
    renderer.setBackgroundColor("#0f141a")
  }, [renderer])

  return screen === "setup" || currentGame(state) === undefined
    ? <SetupScreen store={store} autosaveDir={autosaveDir} onStarted={() => setScreen("scoring")} />
    : <ScoringScreen store={store} state={state} />
}
