import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  resource,
  signal,
} from '@angular/core'
import { Router, RouterLink } from '@angular/router'
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals'
import { interpolate } from '@ngneers/signal-translate'
import { JigButton } from '@awdlab/jig/button'
import { JigCheckbox } from '@awdlab/jig/checkbox'
import { JigChip } from '@awdlab/jig/chip'
import { JigErrors } from '@awdlab/jig/errors'
import { JigIcon } from '@awdlab/jig/icon'
import { JigHint } from '@awdlab/jig/hint'
import { JigInput } from '@awdlab/jig/input'
import { JigInputField } from '@awdlab/jig/input-field'
import { JigMessage } from '@awdlab/jig/message'
import { JigSelect } from '@awdlab/jig/select'
import { JigSpinner } from '@awdlab/jig/spinner'
import { JigTag } from '@awdlab/jig/tag'
import { JigTooltip } from '@awdlab/jig/tooltip'
import tabler3dCubeSphere from '@iconify/icons-tabler/3d-cube-sphere'
import tablerArrowLeft from '@iconify/icons-tabler/arrow-left'
import tablerFilePlus from '@iconify/icons-tabler/file-plus'
import tablerPencil from '@iconify/icons-tabler/pencil'
import tablerPrinter from '@iconify/icons-tabler/printer'
import tablerTrash from '@iconify/icons-tabler/trash'
import type {
  FileDto,
  ProjectDetailDto,
  SlicerId,
  SlicerLaunchDto,
  SlicerLaunchMode,
} from '@spm/contract/dtos.ts'
import { isAppError, type QuotaExceededDetails } from '@spm/contract/errors.ts'
import {
  fileNameSchema,
  projectPatchSchema,
  tagNameSchema,
  type ProjectPatchInput,
} from '@spm/contract/schemas.ts'
import { API_CLIENT, SHELL_CLIENT } from '../../core/api/api-client.token'
import { CapabilitiesStore } from '../../core/capabilities.store'
import { CuraHazardStore } from '../../core/cura-hazard.store'
import { formatBytes } from '../../core/format-bytes'
import { TranslateService } from '../../core/i18n/translate.service'

type EditModel = { name: string; website: string; notes: string; isArchived: boolean }

/**
 * projectPatchSchema spells "no website" as `null`, but a text input can only ever hand back
 * `''` — which `z.url()` rejects, leaving the user unable to clear a website they once set.
 * The empty case therefore validates against the very same schema minus that one field
 * (`.omit`, so no constraint is restated here), and the patch carries `null` instead.
 */
const PATCH_WITHOUT_WEBSITE = projectPatchSchema.omit({ website: true })

/**
 * The single definition of "the website field is empty". Both readers — the validator arm the
 * form picks, and the value the patch carries — go through this, so the two can never drift
 * into a state where a value validated by the no-website arm is sent as a non-null string.
 */
function websiteOrNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function toEditModel(detail: ProjectDetailDto | undefined): EditModel {
  return {
    name: detail?.name ?? '',
    website: detail?.website ?? '',
    notes: detail?.notes ?? '',
    isArchived: detail?.isArchived ?? false,
  }
}

function sameEditModel(a: EditModel, b: EditModel): boolean {
  return (
    a.name === b.name &&
    a.website === b.website &&
    a.notes === b.notes &&
    a.isArchived === b.isArchived
  )
}

/**
 * Every product, in the order the registry lists them, with the name to show for it.
 *
 * Duplicated from `packages/desktop/src/slicers/registry.ts` in one direction only, exactly as
 * `features/desktop/slicers/slicers.page.ts` duplicates it and for the same reasons: the renderer
 * must not import from the desktop package (spec 2.5), and these are brand names rather than
 * translated copy so they are not in the locale files either. What can drift is the *list*, and
 * the assertion below is what stops a sixth `SlicerId` from silently missing a row.
 */
const SLICER_NAMES = [
  { id: 'cura', name: 'UltiMaker Cura' },
  { id: 'prusaslicer', name: 'PrusaSlicer' },
  { id: 'anycubic', name: 'Anycubic Slicer Next' },
  { id: 'bambu', name: 'Bambu Studio' },
  { id: 'orca', name: 'OrcaSlicer' },
] as const satisfies readonly { id: SlicerId; name: string }[]

type AssertNever<T extends never> = T
export type LaunchSlicerNamesAreComplete = AssertNever<
  Exclude<SlicerId, (typeof SLICER_NAMES)[number]['id']>
>

export function slicerDisplayName(id: SlicerId): string {
  return SLICER_NAMES.find((product) => product.id === id)!.name
}

/**
 * Which product a launch would use, as the page has to work it out **before** making the call.
 *
 * **This is the same rule the main process applies, written twice on purpose, and the duplication
 * is worth naming.** The Cura warning has to be shown before the launch, and only the main
 * process knows which slicer the launch will actually pick — so either the page reproduces the
 * rule, or the warning arrives after the file has already been handed over, which is not a
 * warning. The page therefore does not offer either control until it has loaded the same
 * configuration the main process reads, and the answer the launch comes back with
 * (`SlicerLaunchDto.slicerId`) is still the authority for everything shown afterwards.
 *
 * Exported so `project-detail.page.spec.ts` can drive the rule directly, including the two cases
 * the buttons cannot reach.
 */
export function resolveLaunchSlicer(
  mode: SlicerLaunchMode,
  fileSlicer: SlicerId | undefined,
  chosen: SlicerId | null,
  defaultSlicerId: SlicerId | null,
): SlicerId | null {
  if (chosen !== null) return chosen
  if (mode === 'as-is' && fileSlicer !== undefined) return fileSlicer
  return defaultSlicerId
}

/**
 * A launch the page is holding back until the user has answered the Cura warning.
 *
 * It carries the picker's value **as it was when the warning was raised**, rather than letting the
 * continue button re-read it. The two can differ: the picker is live while the warning is up, so a
 * user who changes it and then presses "hand it to Cura anyway" would otherwise launch a product
 * nobody warned them about — and, in the other direction, would reach Cura with no warning at all.
 */
type PendingLaunch = { file: FileDto; mode: SlicerLaunchMode; chosen: SlicerId | null }

@Component({
  selector: 'spm-project-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    JigButton,
    JigCheckbox,
    JigChip,
    JigErrors,
    JigHint,
    JigIcon,
    JigInput,
    JigInputField,
    JigMessage,
    JigSelect,
    JigSpinner,
    JigTag,
    JigTooltip,
    RouterLink,
  ],
  template: `
    <main class="spm-main">
      @if (loadFailed()) {
        <!--
          Ruling 62: reading project.value() after a settled failure throws a
          ResourceValueError, so the error branch has to come first and must not touch it. A
          404 (deleted project, stale bookmark, someone else's id) reads differently from a
          transient failure, and either way there is a way back to the list.
        -->
        <div class="spm-stack">
          <jig-message color="error" role="alert">{{ loadErrorMessage() }}</jig-message>
          <a jigButton kind="secondary" [routerLink]="['/projects']">
            <jig-icon [icon]="icons.back" />
            {{ t.translations().projects.backToProjects }}
          </a>
        </div>
      } @else if (loaded(); as detail) {
        <div class="spm-stack">
          <header class="spm-stack spm-stack--tight">
            <a jigButton kind="link" [routerLink]="['/projects']">
              <jig-icon [icon]="icons.back" />
              {{ t.translations().projects.backToProjects }}
            </a>
            <div class="spm-row">
              <h1>{{ detail.name }}</h1>
              @if (detail.isArchived) {
                <jig-tag color="surface">{{ t.translations().projects.archived }}</jig-tag>
              }
            </div>
            @if (detail.state === 'missing') {
              <jig-message color="warning" role="alert">
                {{ t.translations().projects.missing }}
              </jig-message>
            }
            <!-- One alert for every mutation on the page (ruling 64). -->
            @if (errorMessage(); as message) {
              <jig-message color="error" role="alert">{{ message }}</jig-message>
            }
          </header>

          <section class="spm-card">
            <dl class="spm-details">
              <dt>{{ t.translations().projects.website }}</dt>
              <dd>
                @if (detail.website) {
                  <a [href]="detail.website" target="_blank" rel="noreferrer noopener">
                    {{ detail.website }}
                  </a>
                }
              </dd>
              <dt>{{ t.translations().projects.notes }}</dt>
              <dd>{{ detail.notes }}</dd>
            </dl>
          </section>

          <!--
            Ruling 66: without this form projects.update and projectPatchSchema were reachable
            from nowhere in the web package — no way to rename a project, edit its notes or
            website, or archive it, while the project list already filters and badges archived
            projects. Deliberately plain: a form, not a dialog.
          -->
          <section class="spm-card spm-stack">
            <h2>{{ t.translations().projects.edit }}</h2>
            <form class="spm-stack" (submit)="onSaveEdit(); $event.preventDefault()">
              <div class="spm-field">
                <jig-input-field [label]="t.translations().projects.name">
                  <input
                    jigInput
                    [formField]="editForm.name"
                    jigErrors
                    [jigErrorsHint]="nameHint"
                  />
                </jig-input-field>
                <jig-hint #nameHint />
              </div>

              <div class="spm-field">
                <jig-input-field [label]="t.translations().projects.website">
                  <input
                    jigInput
                    inputmode="url"
                    [formField]="editForm.website"
                    jigErrors
                    [jigErrorsHint]="websiteHint"
                  />
                </jig-input-field>
                <jig-hint #websiteHint />
              </div>

              <div class="spm-field">
                <jig-input-field [label]="t.translations().projects.notes">
                  <textarea
                    jigInput
                    rows="4"
                    [formField]="editForm.notes"
                    jigErrors
                    [jigErrorsHint]="notesHint"
                  ></textarea>
                </jig-input-field>
                <jig-hint #notesHint />
              </div>

              <!--
                Its own key, not the badge's: a non-archived project rendering the bare word
                "Archived" beside a checkbox read as a state, not an action — and it made the
                badge impossible to assert on, since the word was on the page either way.
              -->
              <span class="spm-check">
                <jig-checkbox #archiveBox [formField]="editForm.isArchived" />
                <label [for]="archiveBox.inputId()">
                  {{ t.translations().projects.archive }}
                </label>
              </span>

              <div class="spm-row">
                <button jigButton kind="primary" type="submit" [disabled]="editForm().submitting()">
                  {{ t.translations().projects.save }}
                </button>
              </div>
            </form>
          </section>

          <section class="spm-card spm-stack">
            <h2>{{ t.translations().projects.tags }}</h2>
            <div class="spm-row spm-tags">
              @for (tag of detail.tags; track tag) {
                <jig-chip
                  removable
                  color="primary"
                  (remove)="onRemoveTag(tag)"
                  [attr.aria-label]="t.translations().projects.removeTag + ' ' + tag"
                >
                  {{ tag }}
                </jig-chip>
              }
            </div>
            <jig-input-field class="spm-tag-input" [label]="t.translations().projects.addTag">
              <input
                jigInput
                [attr.aria-label]="t.translations().projects.addTag"
                (keydown.enter)="onTagInput($event)"
              />
            </jig-input-field>
          </section>

          <section class="spm-card spm-stack">
            <h2>{{ t.translations().projects.files }}</h2>
            <input
              type="file"
              [attr.aria-label]="t.translations().projects.upload"
              (change)="onFileInput($event)"
            />

            @if (canLaunch()) {
              <jig-input-field
                class="spm-block"
                inputId="launch-slicer"
                [label]="t.translations().projects.slicerChoice"
              >
                <jig-select
                  inputId="launch-slicer"
                  [label]="t.translations().projects.slicerChoice"
                  [options]="slicerOptions()"
                  [placeholder]="t.translations().projects.slicerAutomatic"
                  [value]="chosenSlicer()"
                  (valueChange)="chosenSlicer.set($event ?? null)"
                />
              </jig-input-field>

              <!--
                Constraint 11: a successful spawn is not evidence the file opened. Three of five
                slicers never put a filename in a window title and one of them was measured
                discarding a file in front of a healthy process, so the app says what it did —
                handed the file over — and never that anything opened.
              -->
              @if (launched(); as launch) {
                <jig-message color="info" role="status">
                  <span>{{ handedMessage(launch) }}</span>
                  <ul>
                    @for (notice of launch.launch.notices; track notice) {
                      <li>{{ notice }}</li>
                    }
                  </ul>
                  <button jigButton kind="text" type="button" (click)="launched.set(null)">
                    {{ t.translations().projects.dismiss }}
                  </button>
                </jig-message>
              }

              @if (curaPending() !== null) {
                <jig-message color="warning" role="alert">
                  <strong>{{ t.translations().projects.curaHazardTitle }}</strong>
                  <p>{{ t.translations().projects.curaHazard }}</p>
                  <span class="spm-check">
                    <jig-checkbox
                      #curaAgainBox
                      [value]="curaDontShowAgain()"
                      (valueChange)="curaDontShowAgain.set($event === true)"
                    />
                    <label [for]="curaAgainBox.inputId()">
                      {{ t.translations().projects.curaHazardDontShow }}
                    </label>
                  </span>
                  <div class="spm-row">
                    <button jigButton kind="primary" type="button" (click)="onCuraContinue()">
                      {{ t.translations().projects.curaHazardContinue }}
                    </button>
                    <button jigButton kind="text" type="button" (click)="curaPending.set(null)">
                      {{ t.translations().projects.cancel }}
                    </button>
                  </div>
                </jig-message>
              }
            }

            <ul class="spm-files">
              @for (file of detail.files; track file.id) {
                <li class="spm-file">
                  <span class="spm-file-thumb">
                    @if (file.thumbUrl) {
                      <img [src]="file.thumbUrl" [alt]="file.name" width="128" height="128" />
                    } @else {
                      <span class="spm-muted">{{ t.translations().projects.previewPending }}</span>
                    }
                    <!--
                      The thumbnail is what a user reaches for, and until now it was inert: a
                      picture of the model sitting two columns left of the icon button that
                      actually opens it. This covers the tile with the same link.

                      aria-hidden + tabindex="-1" on purpose. It is a duplicate of the labelled
                      "View <name>" control in the same row, and an unlabelled second link to
                      the same place is noise in the tab order and in a screen reader's list of
                      links. Mouse and touch get the large target; everything else keeps the
                      one named control. Empty rather than wrapping the image, so the img's alt
                      text is not swallowed into a link name.
                    -->
                    @if (file.kind === 'model') {
                      <a
                        class="spm-file-thumb-hit"
                        [routerLink]="['/projects', id(), 'view', file.id]"
                        tabindex="-1"
                        aria-hidden="true"
                      ></a>
                    }
                  </span>

                  <span class="spm-file-body">
                    <a [href]="file.rawUrl">{{ file.name }}</a>
                    <span class="spm-muted">{{ formatBytes(file.sizeBytes) }}</span>
                    @if (file.slicer) {
                      <jig-tag color="secondary">{{ file.slicer }}</jig-tag>
                    }
                  </span>

                  <!-- Ruling 66: files.rename was unreachable from the whole web package. -->
                  @if (renamingId() === file.id) {
                    <span class="spm-row">
                      <jig-input-field [label]="t.translations().projects.newName" labelKind="on">
                        <input
                          jigInput
                          [value]="renameDraft()"
                          (valueChange)="renameDraft.set($event ?? '')"
                        />
                      </jig-input-field>
                      <button
                        jigButton
                        kind="primary"
                        type="button"
                        (click)="onRenameFile(file, renameDraft())"
                      >
                        {{ t.translations().projects.save }}
                      </button>
                      <button jigButton kind="text" type="button" (click)="cancelRename()">
                        {{ t.translations().projects.cancel }}
                      </button>
                    </span>
                  } @else {
                    <span class="spm-row">
                      <!--
                        The only way into the 3D viewer. The file name beside the thumbnail is
                        a plain link to rawUrl, which downloads the file, and nothing else in
                        the app names the viewer route -- so without this the whole viewer is
                        reachable only by typing a URL.

                        Offered for model files alone, which is exactly the set the viewer's
                        three loaders cover: classifyFile in packages/core assigns that kind
                        to .stl, .obj and a .3mf that is a mesh rather than a slicer project,
                        matching the formats the rasterizer thumbnails.
                      -->
                      @if (file.kind === 'model') {
                        <a
                          jigButton
                          kind="icon"
                          [routerLink]="['/projects', id(), 'view', file.id]"
                          [jigTooltip]="t.translations().projects.view + ' ' + file.name"
                          jigTooltipAutoAriaMode="label"
                        >
                          <jig-icon [icon]="icons.view" />
                        </a>
                      }
                      <!--
                        Two launch paths, and the difference is visible because it has to be: one
                        opens the user's own project where it lives, the other starts a new slicer
                        project from the file — usually in a slicer other than the one that wrote
                        it, and from a stripped copy outside the library.

                        "Open as it is" is offered for a slicer project alone, which is what the
                        main process accepts on that path: for a mesh it would launch the file in
                        place and let the slicer propose its project over the top of it.
                      -->
                      @if (canLaunch()) {
                        @if (file.kind === 'slicer_project') {
                          <button
                            jigButton
                            kind="icon"
                            type="button"
                            [jigTooltip]="t.translations().projects.openInSlicer + ' ' + file.name"
                            jigTooltipAutoAriaMode="label"
                            (click)="onLaunch(file, 'as-is')"
                          >
                            <jig-icon [icon]="icons.openInSlicer" />
                          </button>
                        }
                        <button
                          jigButton
                          kind="icon"
                          type="button"
                          [jigTooltip]="
                            t.translations().projects.newSlicerProject + ' ' + file.name
                          "
                          jigTooltipAutoAriaMode="label"
                          (click)="onLaunch(file, 'new-project')"
                        >
                          <jig-icon [icon]="icons.newSlicerProject" />
                        </button>
                      }
                      <button
                        jigButton
                        kind="icon"
                        type="button"
                        [jigTooltip]="t.translations().projects.rename + ' ' + file.name"
                        jigTooltipAutoAriaMode="label"
                        (click)="startRename(file)"
                      >
                        <jig-icon [icon]="icons.rename" />
                      </button>
                      <button
                        jigButton
                        kind="icon"
                        color="error"
                        type="button"
                        [jigTooltip]="t.translations().projects.deleteFile + ' ' + file.name"
                        jigTooltipAutoAriaMode="label"
                        (click)="onDeleteFile(file)"
                      >
                        <jig-icon [icon]="icons.delete" />
                      </button>
                    </span>
                  }
                </li>
              }
            </ul>
          </section>

          <section class="spm-card spm-stack">
            <span class="spm-check">
              <jig-checkbox
                #deleteFilesBox
                [value]="deleteFiles()"
                (valueChange)="deleteFiles.set($event === true)"
              />
              <label [for]="deleteFilesBox.inputId()">
                {{ t.translations().projects.deleteFiles }}
              </label>
            </span>

            <!--
              Ruling 67: with the box ticked this erases every file of the project from disk,
              irreversibly. The first press only arms it and states the real consequence; the
              second one carries it out.
            -->
            @if (deleteArmed()) {
              <jig-message color="error" role="alert">
                {{
                  deleteFiles()
                    ? t.translations().projects.confirmDeleteWithFiles
                    : t.translations().projects.confirmDelete
                }}
              </jig-message>
              <div class="spm-row">
                <button
                  jigButton
                  kind="primary"
                  color="error"
                  type="button"
                  (click)="onDeleteProject(deleteFiles())"
                >
                  {{ t.translations().projects.confirmDeleteAction }}
                </button>
                <button jigButton kind="text" type="button" (click)="cancelDelete()">
                  {{ t.translations().projects.cancel }}
                </button>
              </div>
            } @else {
              <div class="spm-row">
                <button
                  jigButton
                  kind="secondary"
                  color="error"
                  type="button"
                  (click)="onDeleteProject(deleteFiles())"
                >
                  <jig-icon [icon]="icons.delete" />
                  {{ t.translations().projects.delete }}
                </button>
              </div>
            }
          </section>
        </div>
      } @else {
        <jig-spinner centered [size]="40" />
      }
    </main>
  `,
})
export class ProjectDetailPage {
  private readonly api = inject(API_CLIENT)
  /**
   * The shell, not the library, and that is the whole reason the second token exists.
   *
   * `API_CLIENT` is whatever transport the *library* is on: in the desktop shell's remote mode it
   * is `HttpApiClient`, which refuses every `slicers` method by design. The slicers are a property
   * of the machine the user is sitting at whichever library is open, so the launch controls talk
   * to `SHELL_CLIENT` — the IPC transport in both desktop modes, and in the browser an
   * `HttpApiClient` that refuses, where `canLaunchSlicer` is false and none of this renders.
   */
  private readonly shell = inject(SHELL_CLIENT)
  private readonly capabilities = inject(CapabilitiesStore)
  private readonly cura = inject(CuraHazardStore)
  private readonly router = inject(Router)
  protected readonly t = inject(TranslateService)

  protected readonly icons = {
    back: tablerArrowLeft,
    rename: tablerPencil,
    delete: tablerTrash,
    view: tabler3dCubeSphere,
    openInSlicer: tablerPrinter,
    newSlicerProject: tablerFilePlus,
  }

  readonly id = input.required<string>()

  readonly project = resource({
    params: () => this.id(),
    loader: ({ params }) => this.api.projects.get(params),
  })

  /**
   * `Resource.value()` throws once a load settles to the public 'error' status, so every read
   * of it — here and in the template — is gated on this first (the same pattern as
   * ProjectsStore.loadFailed). `Resource<T>` exposes no `isError()`; `status()` is the
   * public way to ask.
   */
  readonly loadFailed = computed(() => this.project.status() === 'error')

  /** undefined while loading, and (unlike `value()`) safe to read after a failed load. */
  protected readonly loaded = computed<ProjectDetailDto | undefined>(() =>
    this.project.hasValue() ? this.project.value() : undefined,
  )

  protected readonly loadErrorMessage = computed(() =>
    this.loadFailed() ? this.describe(this.project.error()) : null,
  )

  /**
   * Everything below is per-project state, keyed on `id` through linkedSignal, because the
   * router reuses this one component instance across a `:id` change — it only swaps the
   * input. Without that, an error from one project would render over the next one, and (much
   * worse, ruling 67) a delete armed on one project would still be armed on the next, so a
   * single press would destroy the wrong project's files.
   */
  readonly errorMessage = linkedSignal<string, string | null>({
    source: this.id,
    computation: () => null,
  })

  /** The file currently being renamed, and the name being typed for it. */
  readonly renamingId = linkedSignal<string, string | null>({
    source: this.id,
    computation: () => null,
  })
  readonly renameDraft = signal('')

  /** Ruling 67: the delete needs a second, informed press before it destroys anything. */
  readonly deleteFiles = linkedSignal<string, boolean>({
    source: this.id,
    computation: () => false,
  })
  readonly deleteArmed = linkedSignal<string, boolean>({
    source: this.id,
    computation: () => false,
  })

  /* ---------------------------------------------------------------------------------------
   * Handing a file to a slicer
   * ------------------------------------------------------------------------------------ */

  /**
   * The slicer configuration of **this machine**, loaded only where a launch is possible.
   *
   * The page needs it for two things it cannot do without: the products that actually have an
   * install bound, and the configured default — which is what decides whether a launch with no
   * explicit choice would land in Cura. Both controls stay hidden until it has arrived, which is
   * what keeps `resolveLaunchSlicer` from having to guess.
   */
  protected readonly slicerConfig = resource({
    params: () => this.capabilities.capabilities().canLaunchSlicer,
    loader: ({ params }) => (params ? this.shell.slicers.get() : Promise.resolve(null)),
  })

  protected readonly canLaunch = computed(
    () => this.slicerConfig.hasValue() && this.slicerConfig.value() !== null,
  )

  /** The products with an install bound to them; nothing else can be launched today. */
  protected readonly slicerOptions = computed(() => {
    const config = this.slicerConfig.hasValue() ? this.slicerConfig.value() : null
    if (config === null) return []
    return SLICER_NAMES.filter((product) => config.bindings[product.id] !== undefined).map(
      (product) => ({ label: product.name, value: product.id }),
    )
  })

  /** `null` means "let the main process decide", which is what most launches do. */
  readonly chosenSlicer = linkedSignal<string, SlicerId | null>({
    source: this.id,
    computation: () => null,
  })

  /**
   * The last launch, and the name of the file it was given.
   *
   * The name is carried alongside rather than looked up from the launch: `SlicerLaunchDto` names
   * no file, deliberately — it answers about the *launch* — and the file could have been renamed
   * or deleted by the time the message is read.
   */
  readonly launched = linkedSignal<string, { launch: SlicerLaunchDto; fileName: string } | null>({
    source: this.id,
    computation: () => null,
  })

  /** A launch waiting on the Cura warning, and whether the user ticked "don't show again". */
  readonly curaPending = linkedSignal<string, PendingLaunch | null>({
    source: this.id,
    computation: () => null,
  })
  readonly curaDontShowAgain = signal(false)

  /**
   * Seeded from the project, but re-seeded only when the project's identity or its *stored*
   * values actually change — not merely when the resource reloads.
   *
   * Every mutation on this page ends in `project.reload()`, and each reload resolves to a
   * fresh DTO object. Keying this on the loaded DTO alone therefore threw away whatever the
   * user had typed but not yet saved the moment they added a tag, uploaded a file or deleted
   * one — silently, and with the typed text unrecoverable. Comparing the stored values keeps
   * both halves of the guarantee: an in-progress edit survives an unrelated mutation, while a
   * first load, a successful save and an external change all still re-seed the form to what
   * is really stored.
   */
  readonly editModel = linkedSignal<{ id: string; stored: EditModel }, EditModel>({
    source: () => ({ id: this.id(), stored: toEditModel(this.loaded()) }),
    computation: (next, previous) => {
      const unchanged =
        previous !== undefined &&
        previous.source.id === next.id &&
        sameEditModel(previous.source.stored, next.stored)
      return unchanged ? previous.value : next.stored
    },
  })

  // The same schema the server validates with (spec 2.3), via submit() so the field errors
  // land in the jig hints instead of coming back as an undisplayed 400.
  protected readonly editForm = form(this.editModel, (path) => {
    validateStandardSchema(path, ({ value }) =>
      websiteOrNull(value().website) === null ? PATCH_WITHOUT_WEBSITE : projectPatchSchema,
    )
  })

  // Ruling 72.4: extracted to core/format-bytes.ts so admin/users.page.ts (disk usage and
  // quotas) can render the same shape rather than reimplementing it.
  protected readonly formatBytes = formatBytes

  protected async onFileInput(event: Event): Promise<void> {
    const element = event.target as HTMLInputElement
    const file = element.files?.[0]
    if (!file) return
    await this.onUpload(file)
    // Let the same file be picked again — e.g. after freeing up quota.
    element.value = ''
  }

  async onUpload(file: File): Promise<void> {
    // Ruling 61: the `blob` arm, never the `stream` one. `Content-Length` is a forbidden
    // header name, so a script-set one is stripped and a ReadableStream body has no length
    // the browser can compute — the server, which hard-requires the header, then answers 411.
    // A File *is* a Blob, so handing it straight to fetch lets the browser set the length
    // itself (and avoids `duplex: 'half'`, which is Chromium-and-HTTP/2-only).
    await this.mutate(() => this.api.files.upload(this.id(), file.name, { blob: file }))
  }

  /** Resolves to whether the tag was actually added, so the input only clears on success. */
  async onAddTag(name: string): Promise<boolean> {
    // Ruling 65: tagNameSchema is what the server validates with — a 61-character tag used
    // to round-trip to a 400 that nothing displayed. safeParse also trims for us.
    const parsed = tagNameSchema.safeParse(name)
    if (!parsed.success) {
      this.errorMessage.set(this.t.translations().errors.invalidTag)
      return false
    }
    return await this.mutate(() => this.api.projects.addTag(this.id(), parsed.data))
  }

  protected async onTagInput(event: Event): Promise<void> {
    const element = event.target as HTMLInputElement
    // Only wipe the field once the tag is in. A rejected one (too long, a duplicate, a
    // network failure) stays put next to the error, so it can be corrected rather than
    // retyped from scratch.
    if (await this.onAddTag(element.value)) element.value = ''
  }

  async onRemoveTag(name: string): Promise<void> {
    await this.mutate(() => this.api.projects.removeTag(this.id(), name))
  }

  startRename(file: FileDto): void {
    this.renamingId.set(file.id)
    this.renameDraft.set(file.name)
  }

  cancelRename(): void {
    this.renamingId.set(null)
  }

  async onRenameFile(file: FileDto, name: string): Promise<void> {
    // The server's own file-name validator (spec 2.3): path separators, the Windows-reserved
    // set and reserved device names never reach the network.
    const parsed = fileNameSchema.safeParse(name)
    if (!parsed.success) {
      this.errorMessage.set(this.t.translations().errors.invalidFileName)
      return
    }
    await this.mutate(async () => {
      await this.api.files.rename(file.id, parsed.data)
      this.renamingId.set(null)
    })
  }

  async onDeleteFile(file: FileDto): Promise<void> {
    await this.mutate(() => this.api.files.delete(file.id))
  }

  cancelDelete(): void {
    this.deleteArmed.set(false)
  }

  async onDeleteProject(deleteFiles: boolean): Promise<void> {
    this.errorMessage.set(null)
    if (!this.deleteArmed()) {
      // Ruling 67: arm only. Record the choice too, so the confirmation states the real
      // consequence even when the flag comes from the caller rather than the checkbox.
      this.deleteFiles.set(deleteFiles)
      this.deleteArmed.set(true)
      return
    }
    try {
      await this.api.projects.delete(this.id(), { deleteFiles })
      // Disarm as soon as the project is gone: whether the navigation lands or not, there is
      // nothing left here to confirm, and a live "yes, delete" button on an already-deleted
      // project is misleading at best.
      this.deleteArmed.set(false)
      if (!(await this.router.navigate(['/projects']))) {
        // A guard refused it, or the navigation failed. The delete did happen, so say
        // something rather than leaving the user on a page that no longer exists.
        this.errorMessage.set(this.t.translations().errors.generic)
      }
    } catch (error) {
      // Ruling 64: a Forbidden, a 404 or a network blip must show, not vanish. Disarm as
      // well — a live "yes, delete" button must not outlast a failure unexplained.
      this.errorMessage.set(this.describe(error))
      this.deleteArmed.set(false)
    }
  }

  async onSaveEdit(): Promise<void> {
    this.errorMessage.set(null)
    await submit(this.editForm, {
      // `submit` runs `action` only when the form is valid, and it is try/finally with no
      // catch — so a rejected network call inside `action` would otherwise escape as an
      // unhandled rejection (the same reason LoginPage/ProjectsPage catch inside theirs).
      action: async () => {
        const model = this.editModel()
        const patch: ProjectPatchInput = {
          name: model.name.trim(),
          // Nullable in the schema: an emptied field means "no website"/"no notes", which
          // has to reach the API as null rather than as ''. websiteOrNull is the same helper
          // the validator arm above is chosen by, so the two cannot disagree.
          website: websiteOrNull(model.website),
          notes: model.notes.trim() === '' ? null : model.notes,
          isArchived: model.isArchived,
        }
        try {
          await this.api.projects.update(this.id(), patch)
          this.project.reload()
        } catch (error) {
          this.errorMessage.set(this.describe(error))
        }
      },
      // jigErrors shows on `touched`, so an untouched invalid field would fail silently.
      onInvalid: (field) => {
        field().markAsTouched()
      },
    })
  }

  /**
   * A launch the user asked for — held back once for Cura, and only once.
   *
   * The warning is a notice with a way past it and not a gate: Cura against a file is perfectly
   * useful for viewing and slicing, and refusing to launch it would make the feature less useful
   * than not having it. See `CuraHazardStore` for what is being warned about and why the app can
   * neither cause it nor fix it.
   */
  async onLaunch(file: FileDto, mode: SlicerLaunchMode): Promise<void> {
    const config = this.slicerConfig.hasValue() ? this.slicerConfig.value() : null
    const chosen = this.chosenSlicer()
    const willUse = resolveLaunchSlicer(mode, file.slicer, chosen, config?.defaultSlicerId ?? null)
    if (willUse === 'cura' && !this.cura.acknowledged()) {
      this.curaPending.set({ file, mode, chosen })
      return
    }
    await this.launch(file, mode, chosen)
  }

  async onCuraContinue(): Promise<void> {
    const pending = this.curaPending()
    if (pending === null) return
    if (this.curaDontShowAgain()) this.cura.acknowledge()
    this.curaPending.set(null)
    // `pending.chosen`, not `this.chosenSlicer()`: what is launched is what was warned about.
    await this.launch(pending.file, pending.mode, pending.chosen)
  }

  private async launch(
    file: FileDto,
    mode: SlicerLaunchMode,
    chosen: SlicerId | null,
  ): Promise<void> {
    this.errorMessage.set(null)
    this.launched.set(null)
    try {
      const launch = await this.shell.slicers.open(file.id, this.id(), {
        mode,
        // Omitted rather than sent as null: `slicerId` is optional in the contract, and "not
        // stated" is what makes the main process apply its own rule and say which it picked.
        ...(chosen === null ? {} : { slicerId: chosen }),
      })
      this.launched.set({ launch, fileName: file.name })
    } catch (error) {
      this.errorMessage.set(this.describeLaunch(error))
    }
  }

  /** Constraint 11: what was handed over, and to what. Never that anything opened. */
  protected handedMessage(launched: { launch: SlicerLaunchDto; fileName: string }): string {
    return interpolate(this.t.translations().projects.handedTo, {
      file: launched.fileName,
      slicer: `${slicerDisplayName(launched.launch.slicerId)} (${launched.launch.installLabel})`,
    })
  }

  /**
   * Every mutation on this page routes through here (ruling 64): one error surface, one
   * reload, and nothing escaping as an unhandled rejection. Resolves to whether it worked,
   * for the callers that need to know (the tag input keeps its text on a failure).
   */
  private async mutate(action: () => Promise<unknown>): Promise<boolean> {
    this.errorMessage.set(null)
    try {
      await action()
      this.project.reload()
      return true
    } catch (error) {
      this.errorMessage.set(this.describe(error))
      return false
    }
  }

  /**
   * A refused launch shows the shell's own sentence rather than a generic apology.
   *
   * Every refusal this call can produce says something the user can act on — which of three
   * problems stopped a strip and that the other path is still open, or which of two installs of a
   * product they have to choose between — and mapping those onto "something went wrong" would
   * throw away the whole point of the main process having phrased them. They are English whatever
   * the chosen language, exactly as the install labels on `/settings/slicers` already are; giving
   * them a translatable vocabulary is a change to the IPC contract, not to this line.
   */
  private describeLaunch(error: unknown): string {
    return isAppError(error) ? error.message : this.t.translations().errors.generic
  }

  private describe(error: unknown): string {
    const messages = this.t.translations().errors
    if (isAppError(error)) {
      if (error.code === 'QuotaExceeded') {
        const details = error.details as QuotaExceededDetails | undefined
        if (details) {
          // Ruling 63: TranslateService has no `interpolate` method — the package exports a
          // standalone function, and the InterpolatePipe is template-only.
          return interpolate(messages.quotaExceeded, {
            usage: this.formatBytes(details.usageBytes),
            quota: this.formatBytes(details.quotaBytes),
          })
        }
      }
      if (error.code === 'NotFound') return messages.notFound
    }
    return messages.generic
  }
}
