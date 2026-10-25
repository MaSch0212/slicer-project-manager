import { createSignal, For, onMount, Show } from 'solid-js'
import type { UserDto } from '../api/generated'
import {
  createAdminUsers,
  quotaFieldText,
  statusLabelKey,
  statusVariant,
  usagePercent,
} from '../core/admin-users'
import { formatBytes } from '../core/format-bytes'
import { t } from '../core/i18n'
import { notify } from '../core/notify'
import { auth } from '../core/stores'
import {
  Alert,
  Badge,
  Ban,
  Button,
  CircleCheck,
  ConfirmDialog,
  HardDrive,
  Identity,
  Menu,
  PageHeader,
  Progress,
  RefreshCw,
  Send,
  ShieldCheck,
  ShieldOff,
  Skeleton,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  Trash2,
  UserPlus,
  type MenuEntry,
} from '../ui'
import { ActivationDialog, CreateUserDialog, QuotaDialog } from './user-dialogs'

/**
 * `/admin/users` (administrators only): every account with its status, role, usage and quota, and
 * the actions on each. The server decides what is allowed (the last active administrator cannot be
 * demoted, disabled or deleted); its refusal is shown as it comes, and the list is reloaded so it
 * always says what is true.
 */
export default function AdminUsersPage() {
  const admin = createAdminUsers({ onError: (message) => notify.error(message) })
  const [creating, setCreating] = createSignal(false)
  const [link, setLink] = createSignal<{ name: string; url: string } | null>(null)
  const [quotaFor, setQuotaFor] = createSignal<UserDto | null>(null)
  const [deleting, setDeleting] = createSignal<UserDto | null>(null)
  const [deleteBusy, setDeleteBusy] = createSignal(false)

  onMount(() => void admin.load())

  const isSelf = (user: UserDto) => user.id === auth.user()?.id

  async function onReissue(user: UserDto) {
    const url = await admin.reissue(user)
    if (url) setLink({ name: user.displayName, url })
  }

  async function onDelete() {
    const user = deleting()
    if (!user) return
    setDeleteBusy(true)
    try {
      await admin.remove(user)
    } finally {
      setDeleteBusy(false)
      setDeleting(null)
    }
  }

  const actions = (user: UserDto): MenuEntry[] => [
    // Only a pending account can be re-invited: an active one has nothing to activate, and a
    // disabled one must be enabled first (the server refuses both).
    ...(user.status === 'pending'
      ? [{ label: t('admin.reissue'), icon: Send, onSelect: () => void onReissue(user) }]
      : []),
    {
      label: user.status === 'disabled' ? t('admin.enable') : t('admin.disable'),
      icon: user.status === 'disabled' ? CircleCheck : Ban,
      onSelect: () => void admin.setDisabled(user, user.status !== 'disabled'),
    },
    {
      label: user.isAdmin ? t('admin.removeAdmin') : t('admin.makeAdmin'),
      icon: user.isAdmin ? ShieldOff : ShieldCheck,
      onSelect: () => void admin.setAdmin(user, !user.isAdmin),
    },
    { label: t('admin.setQuota'), icon: HardDrive, onSelect: () => setQuotaFor(user) },
    { type: 'separator' },
    { label: t('admin.deleteUser'), icon: Trash2, danger: true, onSelect: () => setDeleting(user) },
  ]

  return (
    <div class="flex flex-col gap-6">
      <PageHeader
        title={t('admin.title')}
        description={t('admin.lead')}
        actions={
          <Button variant="primary" icon={UserPlus} onClick={() => setCreating(true)}>
            {t('admin.createUser')}
          </Button>
        }
      />

      <Show
        when={!admin.loadFailed()}
        fallback={
          <div class="flex flex-col items-start gap-3">
            <Alert variant="danger" class="w-full">
              {t('admin.loadFailed')}
            </Alert>
            <Button icon={RefreshCw} onClick={() => void admin.load()}>
              {t('common.retry')}
            </Button>
          </div>
        }
      >
        <Show
          when={admin.users()}
          fallback={
            <div class="flex flex-col gap-2" aria-busy="true" aria-label={t('common.loading')}>
              <Skeleton class="h-10 w-full" />
              <Skeleton class="h-10 w-full" />
              <Skeleton class="h-10 w-full" />
            </div>
          }
        >
          {(users) => (
            <Table aria-label={t('admin.title')}>
              <Thead>
                <tr>
                  <Th>{t('admin.user')}</Th>
                  <Th>{t('admin.status')}</Th>
                  <Th>{t('admin.isAdmin')}</Th>
                  <Th>{t('admin.usage')}</Th>
                  <Th>{t('admin.quota')}</Th>
                  <Th>
                    <span class="sr-only">{t('admin.actions')}</span>
                  </Th>
                </tr>
              </Thead>
              <Tbody>
                <For each={users()}>
                  {(user) => (
                    <Tr data-username={user.username}>
                      <Td>
                        <Identity
                          title={user.displayName}
                          subtitle={user.username}
                          badge={
                            isSelf(user) ? (
                              <Badge variant="accent">{t('admin.you')}</Badge>
                            ) : undefined
                          }
                        />
                      </Td>
                      <Td>
                        <Badge variant={statusVariant(user.status)}>
                          {t(statusLabelKey(user.status))}
                        </Badge>
                      </Td>
                      <Td>
                        <Show when={user.isAdmin} fallback={<Text variant="muted">&ndash;</Text>}>
                          <Badge variant="accent">{t('admin.isAdmin')}</Badge>
                        </Show>
                      </Td>
                      <Td>
                        <div class="flex min-w-32 flex-col gap-1.5">
                          <span class="tabular-nums">{formatBytes(user.diskUsageBytes)}</span>
                          <Show when={usagePercent(user) !== null}>
                            <Progress
                              value={(usagePercent(user) ?? 0) / 100}
                              label={t('admin.usageOf', {
                                used: formatBytes(user.diskUsageBytes),
                                quota: formatBytes(user.quotaBytes ?? 0),
                              })}
                            />
                          </Show>
                        </div>
                      </Td>
                      <Td class="whitespace-nowrap tabular-nums">
                        {user.quotaBytes === null
                          ? t('admin.unlimited')
                          : formatBytes(user.quotaBytes)}
                      </Td>
                      <Td class="text-right">
                        <Menu
                          iconOnly
                          label={t('admin.rowActions', { name: user.username })}
                          items={actions(user)}
                        />
                      </Td>
                    </Tr>
                  )}
                </For>
              </Tbody>
            </Table>
          )}
        </Show>
      </Show>

      <CreateUserDialog
        open={creating()}
        onOpenChange={setCreating}
        onCreate={async (input) => {
          const url = await admin.create(input)
          setLink({ name: input.displayName, url })
        }}
      />
      <ActivationDialog link={link()} onClose={() => setLink(null)} />
      <QuotaDialog
        target={
          quotaFor()
            ? { name: quotaFor()!.username, initial: quotaFieldText(quotaFor()!.quotaBytes) }
            : null
        }
        onClose={() => setQuotaFor(null)}
        onSave={async (bytes) => {
          const user = quotaFor()
          return user ? await admin.setQuota(user, bytes) : false
        }}
      />
      <ConfirmDialog
        open={deleting() !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('admin.deleteTitle', { name: deleting()?.username ?? '' })}
        message={t('admin.confirmDeleteUser')}
        confirmLabel={t('projects.confirmDeleteAction')}
        cancelLabel={t('common.cancel')}
        danger
        loading={deleteBusy()}
        onConfirm={() => void onDelete()}
      />
    </div>
  )
}
