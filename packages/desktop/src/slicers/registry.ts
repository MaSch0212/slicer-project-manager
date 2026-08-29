import type { SlicerId } from '@spm/contract/dtos.ts'

/**
 * The five slicers, as measured — what each is called, how it is found, and what it does to a
 * file it is handed.
 *
 * **Code, not configuration.** Every field is a measured property of the product
 * (`.superpowers/spikes/2026-08-28-slicer-launch-facts.md`, §§1–2 and §§16, 20), and a user has
 * no business editing any of it: a wrong `exeName` here is the app spawning something that is not
 * the slicer, and a wrong `msixPackageFamily` is a `Get-AppxPackage` query for a package that
 * does not exist. What a user *can* configure — which install of a product to launch, and where a
 * portable install lives — is `slicers.json` (see `config.ts`), and nothing in this file is in it.
 *
 * **There is deliberately no `strip` field** (D decision 1). The strip sets are indexed by the
 * flavour of the *file*, not by the slicer being launched — what can be removed is whatever the
 * authoring slicer put in — and a `SlicerId`-keyed table cannot express the parent spec §3.4
 * rule-4 case, which is a classification with no `SlicerId` at all. They live in
 * `packages/core/src/files/strip3mf.ts`, which is their one home.
 */
export type SlicerDef = {
  id: SlicerId
  displayName: string

  /** How detection finds it on Windows. See `detect.ts`. */
  windows: {
    /**
     * Matched against the uninstall key's `DisplayName`, which carries the version for three of
     * the five: `UltiMaker Cura 5.12.0`, `AnycubicSlicerNext 1.4.1.2`, `PrusaSlicer`,
     * `Bambu Studio`. Anchored at the start and required to end at a word boundary, so
     * `PrusaSlicer` does not also claim a hypothetical `PrusaSlicerXL` — but it does claim
     * `PrusaSlicer 2.9.6`, which is the point.
     */
    displayNamePattern: RegExp
    /**
     * The basename `DisplayIcon` must resolve to. **Validation, not search.**
     *
     * It is what stops `DisplayIcon` resolving to something that sits beside the real executable
     * and is not it: `CuraEngine.exe` (21 MB, so "the biggest exe in the folder" picks it over
     * Cura), `prusa-gcodeviewer.exe`, `prusa-slicer-console.exe` — the headless twin, with the
     * *same* version resource — or one of the four uninstallers. All measured, §1.
     */
    exeName: string
    /**
     * Set only for MSIX products, and OrcaSlicer is the only one today.
     *
     * The family name and not the full name: the full name embeds the version
     * (`OrcaSlicer.OrcaSlicer_2.4.3.0_x64__3qd7h69xpne0g`) and so changes on every update, while
     * the family is stable by construction. This is also the only mechanism that sees Orca at
     * all — it has no uninstall key, no Start Menu shortcut, no `App Paths` entry, is not on
     * `PATH`, and is not findable by a recursive filename search (§2d, §2e, §2g).
     */
    msixPackageFamily?: string
  }

  /**
   * argv for a file. `[file]` for all five (§3), a function so that a sixth need not be.
   *
   * Task 4 is what calls this. It is here rather than there because it is a property of the
   * product, measured with the rest of the row.
   */
  argv(file: string): string[]

  /**
   * What this slicer does to a file it is handed, as measured.
   *
   * Read by the launch paths to decide **two** things: what the app may honestly claim about a
   * launch that is going ahead — `notices()`, which is what the first four flags drive — and
   * whether the launch happens at all, which is `opensStep`. A refusal is not a claim about a
   * launch that is going ahead, so the two are not the same job and the sentence has to name both.
   *
   * Never a strip set — see the module docblock, and see `opensStep` for why that argument runs
   * the other way for this one field.
   */
  behaviour: {
    /**
     * Whether Ctrl+S writes back over the file that was opened.
     *
     * False for Cura alone, and that is not a nicety: Cura proposes a *new* file in the user's
     * own Cura library directory rather than the folder the file came from (§13), so a project
     * opened from the library and saved lands somewhere the app never looks.
     */
    savesInPlace: boolean
    /** Whether an unstripped foreign project is silently discarded — Anycubic (§3, §16, §20). */
    discardsForeignProjects: boolean
    /** Whether a `.3mf` always draws a modal regardless of content — PrusaSlicer (§16, §20). */
    alwaysPromptsOn3mf: boolean
    /** Whether a modal fires on the *absence* of its own config — Bambu (§20). */
    promptsWithoutOwnConfig: boolean
    /**
     * Whether the product reads a `.step` or a `.stp` at all. **False for Cura alone**, and it is
     * the one flag here that stops a launch rather than phrasing a sentence about one.
     *
     * Measured three ways plus a control (2026-08-29 STEP spike §1d). **One:** Cura 5.13.0 handed
     * a `.step` or a `.stp` on argv reaches exactly one visible window, titled
     * `Untitled - UltiMaker Cura 5.13.0`, with no dialog and nothing to dismiss. **Two, the
     * control that makes it a real negative:** the same install in the same session handed
     * `cone.stl` shows `cone - UltiMaker Cura 5.13.0`, so the title *does* pick up a loaded file's
     * basename on that machine and `Untitled` is a measured absence rather than a broken probe.
     * **Three:** Cura's own log says `Unsupported Mime Type Database file extension` seven
     * milliseconds after `Attempting to read file`, and then nothing. **Corroborated from the
     * shipped code:** its plugin directory lists eleven readers by name — `3MFReader`, `AMFReader`,
     * `CuraProfileReader`, `GCodeGzReader`, `GCodeProfileReader`, `GCodeReader`, `ImageReader`,
     * `LegacyProfileReader`, `TrimeshReader`, `UFPReader`, `X3DReader` — none of which reads STEP,
     * in both 5.12.0 and 5.13.0. The other four were measured opening both extensions (§1a–§1c,
     * §2).
     *
     * **What it is not, and this bounds it.** It is not a general capability matrix and must not
     * grow into one. It is one boolean because exactly one measurement distinguishes exactly one
     * product; a `formats: Set<string>` per slicer would be four rows of speculation and one row
     * of evidence, and the four would be unfalsifiable until somebody added a format nobody had
     * measured.
     *
     * **Why this field is admissible under a module docblock that refuses a `strip` one.** The two
     * cases are opposites. A strip set is indexed by the flavour of the *file* — what can be
     * removed is whatever the authoring slicer put in — so it cannot live on a `SlicerId` key at
     * all. STEP capability is indexed by the *product*: it is a fact about Cura, measured on Cura,
     * and the file has nothing to do with it, so a `SlicerId`-keyed table is the only place it can
     * live.
     */
    opensStep: boolean
  }
}

/** Every `SlicerId`, in the order `/settings/slicers` lists them. */
export const SLICER_IDS = [
  'cura',
  'prusaslicer',
  'anycubic',
  'bambu',
  'orca',
] as const satisfies readonly SlicerId[]

/**
 * A compile-time tie between the list above and the contract's union, in both directions.
 *
 * `SLICER_IDS` has to be a value — things iterate it — and a value can drift from a type. The
 * `satisfies` catches a member the union does not have; this catches one the union has and the
 * list does not, which is the direction that would otherwise ship a slicer the app never asks
 * about. `Exclude` is `never` while they agree, and `AssertNever` fails to instantiate otherwise.
 */
type AssertNever<T extends never> = T
export type SlicerIdsAreComplete = AssertNever<Exclude<SlicerId, (typeof SLICER_IDS)[number]>>

export const SLICERS: Readonly<Record<SlicerId, SlicerDef>> = {
  cura: {
    id: 'cura',
    displayName: 'UltiMaker Cura',
    windows: {
      displayNamePattern: /^UltiMaker Cura\b/i,
      exeName: 'UltiMaker-Cura.exe',
    },
    argv: (file) => [file],
    behaviour: {
      savesInPlace: false,
      discardsForeignProjects: false,
      alwaysPromptsOn3mf: false,
      promptsWithoutOwnConfig: false,
      opensStep: false,
    },
  },
  prusaslicer: {
    id: 'prusaslicer',
    displayName: 'PrusaSlicer',
    windows: {
      displayNamePattern: /^PrusaSlicer\b/i,
      exeName: 'prusa-slicer.exe',
    },
    argv: (file) => [file],
    behaviour: {
      savesInPlace: true,
      discardsForeignProjects: false,
      alwaysPromptsOn3mf: true,
      promptsWithoutOwnConfig: false,
      opensStep: true,
    },
  },
  anycubic: {
    id: 'anycubic',
    displayName: 'Anycubic Slicer Next',
    windows: {
      displayNamePattern: /^AnycubicSlicerNext\b/i,
      exeName: 'AnycubicSlicerNext.exe',
    },
    argv: (file) => [file],
    behaviour: {
      savesInPlace: true,
      discardsForeignProjects: true,
      alwaysPromptsOn3mf: false,
      promptsWithoutOwnConfig: false,
      opensStep: true,
    },
  },
  bambu: {
    id: 'bambu',
    displayName: 'Bambu Studio',
    windows: {
      displayNamePattern: /^Bambu Studio\b/i,
      exeName: 'bambu-studio.exe',
    },
    argv: (file) => [file],
    behaviour: {
      savesInPlace: true,
      discardsForeignProjects: false,
      alwaysPromptsOn3mf: false,
      promptsWithoutOwnConfig: true,
      opensStep: true,
    },
  },
  orca: {
    id: 'orca',
    displayName: 'OrcaSlicer',
    windows: {
      displayNamePattern: /^OrcaSlicer\b/i,
      exeName: 'orca-slicer.exe',
      msixPackageFamily: 'OrcaSlicer.OrcaSlicer_3qd7h69xpne0g',
    },
    argv: (file) => [file],
    behaviour: {
      savesInPlace: true,
      discardsForeignProjects: false,
      alwaysPromptsOn3mf: false,
      promptsWithoutOwnConfig: false,
      opensStep: true,
    },
  },
}

/** Narrows an arbitrary value — from the renderer, or from a hand-edited config file. */
export function isSlicerId(value: unknown): value is SlicerId {
  return typeof value === 'string' && Object.hasOwn(SLICERS, value)
}
