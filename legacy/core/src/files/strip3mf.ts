import { copyFileSync, unlinkSync } from 'node:fs'
import { AppError, isAppError } from '@spm/contract/errors.ts'
import { classify3mf, type Classification } from './classify.ts'
import { openZip } from './zip.ts'
import { rewriteZip } from './zip-write.ts'

/**
 * Removing a `.3mf`'s embedded slicer configuration, so a file used to *start a new project* does
 * not carry someone else's print settings into it.
 *
 * **This is the one authoritative home for a strip set.** The sets are indexed by the flavour of
 * the *file*, never by the slicer being launched: what can be removed is whatever the authoring
 * slicer put in, and the launched slicer only decides what the user then sees. That is also why
 * the sets cannot live on a `SlicerId`-keyed registry row — one of the four cases is a
 * classification with no `SlicerId` at all.
 *
 * ## What the measurements say this buys, and what they do not
 *
 * Carried from `.superpowers/spikes/2026-08-28-slicer-launch-facts.md` §20, **not** from any test
 * in this repo: the repo has no real slicer fixtures at all, so nothing here can show that a
 * stripped file stops a slicer prompting.
 *
 * - **Cura**: the "Summary — Cura Project" prompt disappears entirely.
 * - **Anycubic**: this is the headline. A Bambu-lineage `.3mf` that Anycubic *silently discarded*
 *   — window open, plate empty, no dialog and no error — loads cleanly once stripped. Stripping is
 *   not prompt suppression here; it is what makes cross-slicer project creation work at all.
 * - **Orca**: two modals become one, and the survivor is informational.
 * - **PrusaSlicer**: nothing. Its four-way dialog is a function of the `.3mf` extension, measured
 *   down to a three-entry archive with no configuration in it.
 * - **Bambu**: nothing. Its modal fires on the *absence* of its own `project_settings.config`.
 *
 * Even where the prompt stays, the strip still does the job asked of it: the file carries no
 * foreign print configuration, so a user who clicks through gets their own settings.
 *
 * ## Never half-strip
 *
 * Removing `slice_info.config` alone was measured to leave the foreign printer and filament
 * presets in place *and* produce a file `classify3mf` calls `slicer_project` with `slicer: null` —
 * worse than either endpoint. So the strip is all-or-nothing per flavour, the result is
 * **re-classified at run time**, and anything that is not `kind: 'model'` is a refusal rather than
 * a degraded launch. That check is not theoretical: a `.3mf` carrying both `Cura/*` and
 * `Metadata/Slic3r_PE.config` classifies `cura` (first match wins), gets the Cura set, and comes
 * out `prusaslicer`.
 *
 * A refusal never falls back to launching the original — for Anycubic that fallback *is* the
 * silent-discard case — and it always names which of three problems it was, because they have
 * three different next moves.
 */

/** Every entry under this prefix, for a `cura` file. Measured at 15 entries; the prefix is the rule. */
const CURA_STRIP_PREFIX = 'Cura/'

const PRUSA_STRIP_ENTRIES = ['Metadata/Slic3r_PE.config', 'Metadata/Slic3r_PE_model.config']

/**
 * One set for the whole Bambu lineage, and it is the wider of the two that were measured: Anycubic
 * ran with all five, Orca with the first three. The five-entry set is a strict superset, the two
 * extra names are per-project data rather than configuration, and D-2's all-or-nothing rule needs
 * exactly one set per flavour to be checkable at all. **Not measured:** the five-entry set in Orca
 * or Bambu.
 */
const BAMBU_LINEAGE_STRIP_ENTRIES = [
  'Metadata/slice_info.config',
  'Metadata/project_settings.config',
  'Metadata/model_settings.config',
  'Metadata/custom_gcode_per_layer.xml',
  'Metadata/cut_information.xml',
]

/**
 * Which problem a refusal was. The three have three different next moves, and "could not prepare
 * *file*" tells the user none of them.
 */
export type StripRefusalReason =
  /** An entry the rewriter cannot reproduce without a key. */
  | 'encrypted'
  /** Not a readable ZIP, or an archive the rewriter cannot represent. */
  | 'unreadable'
  /** The strip ran and the result still classifies as a slicer project. */
  | 'configuration-left-behind'

/** Reads the reason off a refusal thrown by `strip3mf`; `null` for anything else. */
export function stripRefusalReason(error: unknown): StripRefusalReason | null {
  if (!isAppError(error)) return null
  const reason = error.details?.['reason']
  return reason === 'encrypted' || reason === 'unreadable' || reason === 'configuration-left-behind'
    ? reason
    : null
}

export type Strip3mfResult = {
  /** What the *input* classified as, which is what chose the strip set. */
  classification: Classification
  /**
   * Whether anything was actually removed. `false` means the source held no configuration and
   * the output is a byte-for-byte copy — the caller still has a file it may hand to a slicer.
   */
  stripped: boolean
  /** Entry names removed, in archive order. */
  removed: string[]
  /** Parts rewritten because they referenced a removed part, in archive order. */
  rewritten: string[]
}

/**
 * Writes a stripped copy of `inputPath` at `outputPath`, or refuses.
 *
 * Thumbnails and plate images — `plate_*.png`, `pick_*.png`, `top_*.png`,
 * `Metadata/thumbnail.png` — are **kept**. That is not incidental: the embedded-thumbnail fast
 * path is what gives essentially every project file a preview without rendering, so a strip that
 * discarded the artwork would cost real UI.
 *
 * Refuses with an `AppError('Validation', …)` whose `details.reason` is a `StripRefusalReason`.
 * Nothing is left at `outputPath` when it refuses.
 */
export function strip3mf(inputPath: string, outputPath: string): Strip3mfResult {
  if (inputPath === outputPath) {
    // Not defensive padding: the rewriter opens the output with `w`, which truncates, while it is
    // still reading compressed bytes out of the input. In place, that destroys the source.
    throw refusal('unreadable', 'a 3MF cannot be stripped onto itself', { path: inputPath })
  }
  const classification = classify3mf(inputPath)
  if (classification.kind === 'other') {
    throw refusal('unreadable', 'file is not a readable 3MF archive', { path: inputPath })
  }

  try {
    const result = stripInto(inputPath, outputPath, classification)
    // The run-time half of the never-half-strip rule. Re-reads the file that was just written
    // rather than reasoning about the set that was removed, because the trap is a file carrying
    // two flavours' entries and only one flavour's set having been applied to it.
    const after = classify3mf(outputPath)
    if (after.kind !== 'model') {
      throw refusal(
        'configuration-left-behind',
        'stripping left slicer configuration in the file',
        { was: classification, after },
      )
    }
    return result
  } catch (error) {
    discard(outputPath)
    // Two of `rewriteZip`'s four reasons — `'encrypted'` and `'unreadable'` — are already among
    // the three a user is told, so they travel unchanged. Its `'unrepresentable'` and
    // `'invalid-request'` are not, and land in `'unreadable'` below with everything else.
    if (stripRefusalReason(error) !== null) throw error
    throw refusal('unreadable', 'the 3MF could not be rewritten', { cause: String(error) })
  }
}

function stripInto(
  inputPath: string,
  outputPath: string,
  classification: Classification,
): Strip3mfResult {
  const zip = openZip(inputPath)
  try {
    const names = zip.entries.map((entry) => entry.name)
    const drop = new Set(stripSetFor(classification, names))
    if (drop.size === 0) {
      // Nothing to remove, so nothing is rebuilt: the copy is byte-for-byte the source. A `model`
      // source reaches here, and so does the theoretical project whose set is entirely absent.
      copyFileSync(inputPath, outputPath)
      return { classification, stripped: false, removed: [], rewritten: [] }
    }

    const replace = new Map<string, Uint8Array>()
    const encoder = new TextEncoder()
    for (const entry of zip.entries) {
      if (drop.has(entry.name)) continue
      if (!isReferencingPart(entry.name)) continue
      const original = decode(zip.read(entry))
      const repaired = repairReferences(entry.name, original, drop)
      // Checked on the text that will actually be written, repaired or not. See
      // `danglingReference`: this is what makes the guarantee hold for XML shapes the two element
      // patterns do not match, rather than only for the shapes they were written against.
      const dangling = danglingReference(entry.name, repaired ?? original, drop)
      if (dangling !== null) {
        throw refusal(
          'configuration-left-behind',
          'stripping left a reference to a part it removed',
          { part: entry.name, target: dangling },
        )
      }
      if (repaired !== null) replace.set(entry.name, encoder.encode(repaired))
    }

    zip.close()
    const written = rewriteZip(inputPath, outputPath, { drop, replace })
    return {
      classification,
      stripped: true,
      removed: written.dropped,
      rewritten: written.replaced,
    }
  } finally {
    zip.close()
  }
}

function stripSetFor(classification: Classification, names: string[]): string[] {
  if (classification.kind === 'model') return []
  switch (classification.slicer) {
    case 'cura':
      return names.filter((name) => name.startsWith(CURA_STRIP_PREFIX))
    case 'prusaslicer':
      return PRUSA_STRIP_ENTRIES.filter((name) => names.includes(name))
    // `anycubic`, `bambu`, `orca` and the rule-4 `slicer: null` case — a project saved but never
    // sliced — share one set. Rule 4 matched on `project_settings.config`, and only the lineage
    // writes it.
    default:
      return BAMBU_LINEAGE_STRIP_ENTRIES.filter((name) => names.includes(name))
  }
}

/** The only two kinds of part that can name another part by name. */
function isReferencingPart(name: string): boolean {
  return name === CONTENT_TYPES || isRelsPart(name)
}

/**
 * Returns the repaired text of one part, or `null` when the part needs no repair.
 *
 * - **`_rels` parts.** Any `<Relationship>` whose `Target` resolves to a removed part is dropped.
 *   Measured: needed in exactly one probe, where `Metadata/thumbnail.png` was removed, and
 *   PrusaSlicer accepted the result.
 * - **`[Content_Types].xml`.** Any `<Override PartName="…">` naming a removed part is dropped. In
 *   all five measured flavours this fires on nothing at all, because they declare `Default
 *   Extension` entries only — but "five files did not need it" is not "the format does not
 *   require it", so it is checked rather than assumed.
 *
 * Every other part is left alone; the strip never rewrites a payload.
 *
 * **What the element patterns below do and do not match, probed rather than assumed.** Eight XML
 * shapes were run through this function. Six are repaired: attributes in any order, single or
 * double quotes, the self-closing and the paired forms, an XML comment in the way, and a
 * percent-encoded target. One more is repaired *because* the patterns allow a namespace prefix —
 * `<r:Relationship>` is legal OPC and an earlier draft of these patterns dropped it on the floor.
 * The eighth, a `>` inside an attribute value, is **not** matched and is not repaired: `[^>]*?`
 * stops at it, and a real attribute grammar means an XML parser, which core's lint rules do not
 * permit as a dependency.
 *
 * That last shape is why `danglingReference` exists and why this function is not the guarantee.
 * A pattern that silently matches nothing produces an archive whose relationship names a part that
 * is gone, reported as success — which is worse than a mis-edit, because there is no signal at
 * all. The outcome check is what turns that into a refusal.
 */
function repairReferences(name: string, text: string, removed: ReadonlySet<string>): string | null {
  if (name === CONTENT_TYPES) {
    return dropElements(text, OVERRIDE_ELEMENT, (element) => {
      const declared = attribute(element, 'PartName')
      if (declared === null) return false
      const part = resolvePartName(name, declared)
      return part !== null && removed.has(part)
    })
  }
  return dropElements(text, RELATIONSHIP_ELEMENT, (element) => {
    // An external relationship names a URI, not a part, so it can never be one of the removed.
    // `danglingReference` does not make this distinction and cannot: it is blind to the element
    // an attribute sits in. So an external relationship with a *relative* target that resolves
    // onto a removed part is repaired-as-nothing here and then refused there. Contradictory only
    // in appearance — this one is about what is safe to delete, that one about what is safe to
    // ship — and it is listed among that function's known false positives.
    if (attribute(element, 'TargetMode') === 'External') return false
    const target = attribute(element, 'Target')
    if (target === null) return false
    const part = resolvePartName(name, target)
    return part !== null && removed.has(part)
  })
}

/**
 * The name of a removed part still referenced by `text`, or `null` when none is.
 *
 * A check on the **outcome** rather than on the pattern: it scans for the two attributes that can
 * name a part — wherever they appear, in whatever element, prefixed or not, with or without a `>`
 * in some neighbouring value — resolves each the way a parser would, and asks whether the result
 * is a part this strip removed. A reference that survives becomes a refusal naming the part
 * instead of a success quietly shipping a dangling one.
 *
 * **What it does not cover, because a probe found it rather than an author guessing it.** An
 * earlier draft of this comment claimed the check "holds for XML shapes neither the patterns above
 * nor their author anticipated". It did not, and the counter-example was the original defect
 * again: an entity-encoded target went past both. That is now decoded in `resolvePartName`, and
 * the general claim is withdrawn rather than re-made one shape wider. What is true is narrower and
 * checkable: **this sees any reference written as a `Target=` or `PartName=` attribute whose value
 * a parser would resolve to a removed part, through character references and percent-escapes.** A
 * reference carried some other way — a `Target` assembled from an entity-expanded DTD, a namespace
 * this code does not know names parts — would still pass. No measured flavour writes any of that,
 * and this comment is the record of where the line is, not a promise there is none.
 *
 * **Known false positives**, all three probed, all three refusals on files that are legal and
 * previously stripped cleanly: the same attribute text inside **an XML comment**, inside **a CDATA
 * section**, or on **an external relationship with a relative URI** — `repairReferences` skips
 * `TargetMode="External"` deliberately and this check cannot, being blind to the element the
 * attribute sits in, which is the same blindness that gives it its reach. Erring this way is
 * constraint 9's direction: a refusal that names the part beats the silent success it replaced.
 * Skipping comments and CDATA would mean tracking their nesting — a second partial XML parser
 * beside the one whose partiality caused this finding, each new rule a new way to blind the check.
 */
function danglingReference(
  name: string,
  text: string,
  removed: ReadonlySet<string>,
): string | null {
  for (const match of text.matchAll(PART_REFERENCE)) {
    const reference = match[1] ?? match[2]
    if (reference === undefined) continue
    const part = resolvePartName(name, reference)
    if (part !== null && removed.has(part)) return part
  }
  return null
}

const CONTENT_TYPES = '[Content_Types].xml'

/**
 * A part in a `_rels` directory. The plan writes this as "`_rels/*.xml`"; every `.3mf` measured
 * actually holds `_rels/.rels`, and OPC's own name for a part's relationships is
 * `<dir>/_rels/<part>.rels`. Matching the directory rather than an extension covers both.
 */
function isRelsPart(name: string): boolean {
  return /(?:^|\/)_rels\/[^/]+$/.test(name)
}

/**
 * An optional namespace prefix: `<r:Relationship>` is legal OPC and no measured file uses one.
 * The `\b` after the element name is what keeps `<Relationships>`, the plural root element, from
 * matching — there is no word boundary between `p` and `s`.
 */
const PREFIX = '(?:[A-Za-z_][\\w.-]*:)?'
const RELATIONSHIP_ELEMENT = new RegExp(
  `<${PREFIX}Relationship\\b[^>]*?(?:/>|>[\\s\\S]*?</${PREFIX}Relationship\\s*>)`,
  'g',
)
const OVERRIDE_ELEMENT = new RegExp(
  `<${PREFIX}Override\\b[^>]*?(?:/>|>[\\s\\S]*?</${PREFIX}Override\\s*>)`,
  'g',
)

/**
 * The two OPC attributes that can name a part, wherever they appear. Deliberately blind to the
 * element around them: that is what lets `danglingReference` see a reference an element pattern
 * missed.
 */
const PART_REFERENCE = /\b(?:Target|PartName)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function attribute(element: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(element)
  if (match === null) return null
  return match[1] ?? match[2] ?? null
}

/** Removes each matching element the predicate accepts; `null` when it accepted none. */
function dropElements(
  text: string,
  pattern: RegExp,
  drop: (element: string) => boolean,
): string | null {
  let changed = false
  const out = text.replace(pattern, (element) => {
    if (!drop(element)) return element
    changed = true
    return ''
  })
  return changed ? out : null
}

/** The five entities XML predefines. Everything else numeric is handled by code point. */
const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
])
const CHARACTER_REFERENCE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g

/**
 * What an XML parser hands a consumer for an attribute value: character references resolved.
 *
 * Not a nicety. `Target="…custom_gcode_per_layer&#46;xml"` is legal XML naming
 * `…custom_gcode_per_layer.xml`, and the review found it slipping past both the element patterns
 * and the outcome check — a strip returning success over an archive still naming a removed part,
 * which is verbatim the defect the outcome check was added to close.
 */
function decodeCharacterReferences(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(
    CHARACTER_REFERENCE,
    (whole: string, decimal?: string, hex?: string, named?: string) => {
      if (named !== undefined) return NAMED_ENTITIES.get(named) ?? whole
      const digits = decimal ?? hex
      if (digits === undefined) return whole
      const code = Number.parseInt(digits, decimal !== undefined ? 10 : 16)
      try {
        return String.fromCodePoint(code)
      } catch {
        // Outside the Unicode range, so not a character and not part of a part name.
        return whole
      }
    },
  )
}

/**
 * The part name an OPC `Target` or `PartName` refers to, as a ZIP entry name; `null` for anything
 * that does not name a part in this package.
 *
 * A `Target` is relative to the directory the `_rels` folder sits in — so `3D/3dmodel.model` in
 * `_rels/.rels` is the root-level part, and the same string in `3D/_rels/x.rels` is
 * `3D/3D/3dmodel.model`. A leading `/` makes it absolute from the package root, which is the form
 * `[Content_Types].xml` always uses.
 *
 * **Two decodings, and the order is load-bearing.** XML character references come off first,
 * because that is what a parser resolves before the value is ever a URI — and because `&#46;`
 * contains a `#`, so splitting the fragment first turns `…layer&#46;xml` into `…layer&` and
 * silently loses the extension. That was the mechanism of the hole this closes. Percent-escapes
 * come off second, being a property of the URI the parser produced.
 */
function resolvePartName(partName: string, reference: string): string | null {
  const literal = decodeCharacterReferences(reference)
  // An absolute URI (http:, mailto:) names something outside the package.
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(literal)) return null
  const withoutFragment = literal.split('#')[0]!.split('?')[0]!
  let decoded = withoutFragment
  try {
    decoded = decodeURIComponent(withoutFragment)
  } catch {
    // A malformed escape is not a part name we can resolve; compare the raw text instead.
  }
  // Drop the `_rels` segment and the `.rels` file itself to get the base directory.
  const base = decoded.startsWith('/') ? [] : partName.split('/').slice(0, -2)
  for (const segment of decoded.replace(/^\//, '').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') base.pop()
    else base.push(segment)
  }
  return base.join('/')
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function refusal(
  reason: StripRefusalReason,
  message: string,
  details: Record<string, unknown>,
): AppError {
  return new AppError('Validation', message, { ...details, reason })
}

function discard(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Nothing was written, or the platform will not let us; the refusal is what matters.
  }
}
