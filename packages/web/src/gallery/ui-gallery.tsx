import { createSignal, For, type JSX } from 'solid-js'
import type { Theme } from '../api/generated'
import { notify } from '../core/notify'
import { applyTheme } from '../core/theme'
import {
  Alert,
  Archive,
  ArchiveRestore,
  ArchiveX,
  ArrowUpDown,
  Badge,
  Button,
  Card,
  CopyField,
  SectionCard,
  SettingRow,
  Checkbox,
  ConfirmDialog,
  Dialog,
  Divider,
  DropZone,
  FileArchive,
  Cuboid,
  Download,
  Eye,
  ImageOff,
  EmptyState,
  FolderOpen,
  FormField,
  Heading,
  IconButton,
  Input,
  Link,
  LinkButton,
  MediaCard,
  Progress,
  StatList,
  ToggleIconButton,
  IconLinkButton,
  Stage,
  Thumb,
  Menu,
  MultiSelect,
  Monitor,
  Moon,
  PageHeader,
  Pencil,
  Plus,
  SegmentedControl,
  Select,
  Skeleton,
  Spinner,
  Sun,
  Palette,
  Switch,
  Table,
  TabPanel,
  Tabs,
  Tag,
  TagInput,
  Tbody,
  Td,
  Text,
  Textarea,
  Th,
  Thead,
  Tooltip,
  Tr,
  Trash2,
  Upload,
  type BadgeVariant,
  type ButtonVariant,
} from '../ui'

const BUTTON_VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger']
const BADGE_VARIANTS: BadgeVariant[] = ['neutral', 'accent', 'success', 'warning', 'danger']

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-4">
      <Heading level={2}>{props.title}</Heading>
      {props.children}
    </section>
  )
}

function Row(props: { label?: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-2">
      {props.label ? <Text variant="label">{props.label}</Text> : null}
      <div class="flex flex-wrap items-center gap-3">{props.children}</div>
    </div>
  )
}

/**
 * Every component in every variant, on one page: the visual check for the design system.
 * Development only (`/_ui`); production builds do not contain it. It obeys the same rule as the
 * app: no colours, borders, radii or font sizes here, only the library.
 */
export default function UiGallery() {
  const [theme, setTheme] = createSignal<Theme>('system')
  const [tab, setTab] = createSignal('files')
  const [dialog, setDialog] = createSignal(false)
  const [confirm, setConfirm] = createSignal(false)
  const [tags, setTags] = createSignal(['benchy', 'calibration'])
  const [filter, setFilter] = createSignal(['Calibration', 'Gadgets'])
  const [sort, setSort] = createSignal('updatedAt')
  const [notes, setNotes] = createSignal('')
  const [checked, setChecked] = createSignal(true)
  const [on, setOn] = createSignal(true)
  const [archived, setArchived] = createSignal(false)
  const [view, setView] = createSignal<'grid' | 'list'>('grid')
  const [dropped, setDropped] = createSignal<string[]>([])

  return (
    <div class="flex flex-col gap-10" data-testid="ui-gallery">
      <PageHeader
        title="UI gallery"
        description="Every component in every variant. Development only."
        actions={
          <SegmentedControl
            label="Theme"
            value={theme()}
            options={[
              { value: 'system', label: 'System', icon: Monitor },
              { value: 'light', label: 'Light', icon: Sun },
              { value: 'dark', label: 'Dark', icon: Moon },
            ]}
            onChange={(next) => {
              setTheme(next)
              applyTheme(next)
            }}
          />
        }
      />

      <Section title="Tokens">
        <Palette />
      </Section>

      <Section title="Typography">
        <Heading level={1}>Heading 1</Heading>
        <Heading level={2}>Heading 2</Heading>
        <Heading level={3}>Heading 3</Heading>
        <Text>Body text, the default reading size for the app.</Text>
        <Text variant="muted">Muted text for secondary information.</Text>
        <Text variant="small">Small text for hints and captions.</Text>
        <Text variant="label">Label text</Text>
        <Text variant="mono">mono-text-for-ids.3mf</Text>
        <Text>
          An in-app <Link href="/projects">link</Link> and an{' '}
          <Link href="https://example.com" external>
            external link
          </Link>
          .
        </Text>
        <Divider />
      </Section>

      <Section title="Buttons">
        <For each={BUTTON_VARIANTS}>
          {(variant) => (
            <Row label={variant}>
              <Button variant={variant}>Default</Button>
              <Button variant={variant} icon={Plus}>
                With icon
              </Button>
              <Button variant={variant} size="sm">
                Small
              </Button>
              <Button variant={variant} loading>
                Loading
              </Button>
              <Button variant={variant} disabled>
                Disabled
              </Button>
            </Row>
          )}
        </For>
        <Row label="link button">
          <LinkButton href="/projects" variant="primary" icon={FolderOpen}>
            Go to projects
          </LinkButton>
          <LinkButton href="/projects">Secondary link</LinkButton>
        </Row>
        <Row label="icon buttons">
          <IconButton icon={Pencil} label="Edit" />
          <IconButton icon={Pencil} label="Edit" variant="secondary" />
          <IconButton icon={Trash2} label="Delete" variant="danger" />
          <IconButton icon={Plus} label="Add" variant="primary" size="sm" />
          <IconButton icon={Archive} label="Archive" disabled />
        </Row>
      </Section>

      <Section title="Form controls">
        <div class="grid gap-5 sm:grid-cols-2">
          <FormField label="Name" hint="What the project folder is called on disk." required>
            <Input placeholder="Benchy" />
          </FormField>
          <FormField label="Source URL" error="Enter an address starting with http:// or https://">
            <Input value="not a url" />
          </FormField>
          <FormField label="Search">
            <Input leading={FolderOpen} placeholder="Search projects" />
          </FormField>
          <FormField label="Disabled">
            <Input value="Read only" disabled />
          </FormField>
          <FormField label="Sort by">
            <Select
              value={sort()}
              onChange={setSort}
              options={[
                { value: 'updatedAt', label: 'Recently updated' },
                { value: 'name', label: 'A-Z' },
                { value: 'createdAt', label: 'Newest' },
              ]}
            />
          </FormField>
          <FormField label="Tags filter">
            <MultiSelect
              label="Tags"
              value={filter()}
              onChange={setFilter}
              options={['Calibration', 'Gadgets', 'Printer parts', 'Toys'].map((name) => ({
                value: name,
                label: name,
              }))}
            />
          </FormField>
          <FormField label="Tags" hint="Press Enter to add a tag." class="sm:col-span-2">
            <TagInput
              label="Tags"
              value={tags()}
              onChange={setTags}
              suggestions={['gadgets', 'toys', 'printer-parts', 'benchy']}
              maxLength={60}
              placeholder="Add a tag"
            />
          </FormField>
          <FormField label="Notes" class="sm:col-span-2">
            <Textarea
              value={notes()}
              onInput={(event) => setNotes(event.currentTarget.value)}
              placeholder="Anything worth remembering"
            />
          </FormField>
        </div>
        <Row label="toggles">
          <Checkbox label="Show archived" checked={checked()} onChange={setChecked} />
          <Checkbox label="Unchecked" />
          <Checkbox label="Indeterminate" indeterminate />
          <Checkbox label="Disabled" disabled />
          <Switch label="Collapse the navigation" checked={on()} onChange={setOn} />
          <Switch label="Off" />
          <Switch label="Disabled" disabled />
        </Row>
      </Section>

      <Section title="Tags and badges">
        <Row label="tags">
          <Tag>benchy</Tag>
          <Tag variant="neutral">neutral</Tag>
          <Tag onRemove={() => {}} removeLabel="Remove gadgets">
            gadgets
          </Tag>
        </Row>
        <Row label="badges">
          <For each={BADGE_VARIANTS}>{(variant) => <Badge variant={variant}>{variant}</Badge>}</For>
        </Row>
      </Section>

      <Section title="Library">
        <Row label="filter bar controls">
          <Select
            aria-label="Sort"
            leading={ArrowUpDown}
            class="min-w-44"
            value={sort()}
            onChange={setSort}
            options={[
              { value: 'updatedAt', label: 'Recently updated' },
              { value: 'name', label: 'A-Z' },
            ]}
          />
          <ToggleIconButton
            label="Show archived"
            pressed={archived()}
            onPressedChange={setArchived}
            iconOn={Archive}
            iconOff={ArchiveX}
          />
          <IconLinkButton href="/projects" icon={Eye} label="View in 3D" />
          <IconLinkButton
            href="/api/files/x/raw"
            icon={Download}
            label="Download"
            external
            download="benchy.stl"
          />
          <SegmentedControl
            iconOnly
            label="Project view"
            value={view()}
            onChange={setView}
            options={[
              { value: 'grid', label: 'Grid', icon: ArchiveRestore },
              { value: 'list', label: 'List', icon: FileArchive },
            ]}
          />
        </Row>
        <div
          class={
            view() === 'grid' ? 'grid grid-cols-2 gap-4 sm:grid-cols-4' : 'flex flex-col gap-2'
          }
        >
          <MediaCard
            layout={view()}
            href="/projects"
            title="Benchy"
            meta="3 files"
            placeholder="Preview pending"
            badges={
              <>
                <Tag>boats</Tag>
                <Badge>Archived</Badge>
              </>
            }
          />
          <MediaCard
            layout={view()}
            title="A project with a very long name that has to be cut off somewhere sensible"
            meta="12 files"
            placeholderIcon={Cuboid}
            placeholder="Preview failed"
            badges={<Badge variant="danger">Folder missing</Badge>}
            actions={<IconButton icon={Pencil} label="Rename" size="sm" />}
          />
        </div>
        <Row label="thumbnail">
          <Thumb class="size-24" placeholder="No preview" placeholderIcon={ImageOff} />
        </Row>
        <Row label="drop zone">
          <DropZone
            class="w-full"
            label="Drag files here"
            buttonLabel="Choose files"
            hint="STL, OBJ, 3MF and other files"
            onFiles={(files) => setDropped(files.map((file) => file.name))}
          />
        </Row>
        <Text variant="small">Dropped: {dropped().join(', ') || 'nothing yet'}</Text>
        <Row label="progress">
          <div class="flex w-full max-w-sm flex-col gap-3">
            <Progress label="Uploading" value={0.4} />
            <Progress label="Waiting for the size" />
          </div>
        </Row>
        <Row label="stat list">
          <StatList
            items={[
              { label: 'Projects created', value: 3 },
              { label: 'Files added', value: 12 },
            ]}
          />
        </Row>
        <Stage class="!h-40" />
      </Section>

      <Section title="Alerts">
        <Alert variant="info" title="Heads up">
          Something worth knowing, shown in place.
        </Alert>
        <Alert variant="success">The library was rescanned.</Alert>
        <Alert variant="warning">Folder missing on disk.</Alert>
        <Alert variant="danger">Username or password is not correct.</Alert>
      </Section>

      <Section title="Cards">
        <div class="grid gap-4 sm:grid-cols-2">
          <Card>
            <Text>A plain card.</Text>
          </Card>
          <Card interactive>
            <Text>An interactive card, lifted on hover.</Text>
          </Card>
        </div>
        <SectionCard title="Section card" description="A titled block of a settings-style page.">
          <SettingRow label="A setting" hint="Its control sits on the right.">
            <Switch label="A setting" labelHidden checked={on()} onChange={setOn} />
          </SettingRow>
          <SettingRow label="Another setting">
            <Button size="sm">Change</Button>
          </SettingRow>
        </SectionCard>
        <CopyField
          value="http://127.0.0.1:3000/activate#example-token"
          label="Activation link"
          copyLabel="Copy link"
          copiedLabel="Copied"
        />
      </Section>

      <Section title="Tabs">
        <Tabs
          label="Files"
          value={tab()}
          onChange={setTab}
          items={[
            { value: 'files', label: 'Files' },
            { value: 'notes', label: 'Notes' },
            { value: 'history', label: 'History', disabled: true },
          ]}
        >
          <TabPanel value="files">
            <Text variant="muted">The files of this project.</Text>
          </TabPanel>
          <TabPanel value="notes">
            <Text variant="muted">Notes about this project.</Text>
          </TabPanel>
        </Tabs>
      </Section>

      <Section title="Table">
        <Table>
          <Thead>
            <Tr>
              <Th>Name</Th>
              <Th>Kind</Th>
              <Th>Size</Th>
            </Tr>
          </Thead>
          <Tbody>
            <Tr>
              <Td>benchy.3mf</Td>
              <Td>
                <Badge variant="accent">Slicer project</Badge>
              </Td>
              <Td>4.2 MB</Td>
            </Tr>
            <Tr>
              <Td>hull.stl</Td>
              <Td>
                <Badge>Model</Badge>
              </Td>
              <Td>12.0 MB</Td>
            </Tr>
          </Tbody>
        </Table>
      </Section>

      <Section title="Overlays">
        <Row>
          <Menu
            label="Actions"
            variant="secondary"
            items={[
              { label: 'Rename', icon: Pencil, onSelect: () => {} },
              { label: 'Upload', icon: Upload, onSelect: () => {} },
              { type: 'separator' },
              { label: 'Delete', icon: Trash2, danger: true, onSelect: () => {} },
            ]}
          />
          <Menu
            iconOnly
            label="More"
            items={[{ label: 'Archive', icon: Archive, onSelect: () => {} }]}
          />
          <Tooltip content="A short hint">
            <Badge>Hover or focus me</Badge>
          </Tooltip>
          <Button onClick={() => setDialog(true)}>Open dialog</Button>
          <Button variant="danger" onClick={() => setConfirm(true)}>
            Open confirmation
          </Button>
        </Row>
        <Row label="toasts">
          <Button onClick={() => notify.success('Project saved')}>Success</Button>
          <Button onClick={() => notify.info('Rescan queued')}>Info</Button>
          <Button onClick={() => notify.error('Something went wrong')}>Error</Button>
        </Row>
        <Dialog
          open={dialog()}
          onOpenChange={setDialog}
          title="Edit project"
          description="Change what the library shows for this project."
          footer={
            <>
              <Button variant="secondary" onClick={() => setDialog(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setDialog(false)}>
                Save changes
              </Button>
            </>
          }
        >
          <FormField label="Name">
            <Input value="Benchy" />
          </FormField>
        </Dialog>
        <ConfirmDialog
          open={confirm()}
          onOpenChange={setConfirm}
          title="Delete this project?"
          message="The project and its tags are removed; the files stay on disk."
          confirmLabel="Yes, delete"
          cancelLabel="Cancel"
          danger
          onConfirm={() => setConfirm(false)}
        />
      </Section>

      <Section title="Loading and empty">
        <Row label="spinner">
          <Spinner size="sm" />
          <Spinner />
          <Spinner size="lg" label="Loading" />
        </Row>
        <Row label="skeleton">
          <Skeleton class="h-4 w-48" />
          <Skeleton class="h-10 w-10" circle />
          <Skeleton class="h-24 w-40" />
        </Row>
        <EmptyState
          icon={FolderOpen}
          title="No projects yet"
          description="Create a project, or import a CuraManager library."
          action={
            <Button variant="primary" icon={Plus}>
              New project
            </Button>
          }
        />
      </Section>
    </div>
  )
}
