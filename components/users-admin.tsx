'use client'

import { Fragment, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type User = {
  id: string
  fullName: string
  /** What they type to sign in (mig 0027). Unique case-insensitively. */
  loginId: string
  /** Contact information only since 0027 — may be absent. */
  mobile: string | null
  email: string | null
  isActive: boolean
  roleId: string
  roleName: string
  /** The lodge a Lodge Manager answers for (mig 0013); null for every other role. */
  lodgingUnitId: string | null
  /** The properties a Banquet Manager answers for (mig 0017); one manager may hold several. */
  propertyIds: string[]
}
type Role = { id: string; name: string }
type Unit = { id: string; name: string }
type Property = { id: string; name: string; banquetManagerId: string | null }

const blankForm = {
  fullName: '',
  loginId: '',
  mobile: '',
  email: '',
  roleId: '',
  password: '',
  lodgingUnitId: '',
  propertyIds: [] as string[],
}
type Form = typeof blankForm

export function UsersAdmin() {
  const [users, setUsers] = useState<User[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [properties, setProperties] = useState<Property[]>([])
  const [form, setForm] = useState<Form>(blankForm)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  /** The row open for editing, and the row whose Delete is awaiting a second press. */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  async function load() {
    const [usersRes, { roles }] = await Promise.all([
      api<{ users: User[]; lodgingUnits: Unit[]; properties: Property[] }>('/users'),
      api<{ roles: Role[] }>('/roles'),
    ])
    setUsers(usersRes.users)
    setUnits(usersRes.lodgingUnits)
    setProperties(usersRes.properties)
    setRoles(roles)
    setLoading(false)
  }

  useEffect(() => {
    // Initial data fetch: state is set in an async continuation after the await, not
    // during render, so this is a legitimate effect fetch rather than derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [])

  async function createUser(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    try {
      await api('/users', { method: 'POST', body: JSON.stringify(scopedBody(form, roleNameOf(form.roleId))) })
      toast.success(`${form.fullName} added`)
      setForm(blankForm)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create user')
    } finally {
      setCreating(false)
    }
  }

  async function patchUser(id: string, patch: Record<string, unknown>, label: string) {
    try {
      await api(`/users/${id}`, { method: 'PUT', body: JSON.stringify(patch) })
      toast.success(label)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    }
  }

  async function deleteUser(u: User) {
    try {
      await api(`/users/${u.id}`, { method: 'DELETE' })
      toast.success(`${u.fullName} deleted`)
      setConfirmingId(null)
      await load()
    } catch (err) {
      // The common outcome: the account has history and the audit trail holds it. The
      // message names Disable, so it is left on screen long enough to read.
      toast.error(err instanceof Error ? err.message : 'Delete failed', { duration: 10000 })
    }
  }

  const roleNameOf = (id: string) => roles.find((r) => r.id === id)?.name ?? ''
  // base-ui Select renders the raw value in the trigger unless Root is given an items
  // map to resolve each value to its label. Without this the trigger shows the role's
  // UUID instead of its name.
  const roleItems = roles.map((r) => ({ value: r.id, label: formatName(r.name) }))
  const unitItems = units.map((u) => ({ value: u.id, label: u.name }))

  /** What a user is responsible for, for the table's Unit column. */
  function unitLabel(u: User): string {
    if (u.roleName === 'lodge_manager') {
      return units.find((x) => x.id === u.lodgingUnitId)?.name ?? 'No lodge set'
    }
    if (u.roleName === 'banquet_manager') {
      const names = properties.filter((p) => u.propertyIds.includes(p.id)).map((p) => p.name)
      return names.length ? names.join(', ') : 'No property set'
    }
    return '—'
  }

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle>Add a user</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={createUser} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Full name">
              <Input
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                required
              />
            </Field>
            <Field label="ID (this is their login)">
              <Input
                value={form.loginId}
                onChange={(e) => setForm({ ...form, loginId: e.target.value })}
                placeholder="e.g. booking1"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
              />
            </Field>
            <Field label="Mobile (optional)">
              <Input
                value={form.mobile}
                onChange={(e) => setForm({ ...form, mobile: e.target.value })}
              />
            </Field>
            <Field label="Email (optional)">
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            <Field label="Role">
              <Select
                items={roleItems}
                value={form.roleId}
                onValueChange={(v) =>
                  setForm({ ...form, roleId: v ?? '', lodgingUnitId: '', propertyIds: [] })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {formatName(r.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Temporary password">
              <Input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                minLength={8}
                required
              />
            </Field>
            <ScopeFields
              roleName={roleNameOf(form.roleId)}
              units={units}
              unitItems={unitItems}
              properties={properties}
              users={users}
              value={form}
              onChange={(patch) => setForm({ ...form, ...patch })}
            />
            <div className="flex items-end">
              <Button type="submit" disabled={creating || !form.roleId}>
                {creating ? 'Adding…' : 'Add user'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Mobile</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Lodge / property</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : (
              users.map((u) => (
                <Fragment key={u.id}>
                <TableRow className={u.isActive ? '' : 'opacity-60'}>
                  <TableCell className="font-medium">{u.fullName}</TableCell>
                  <TableCell className="font-mono text-sm">{u.loginId}</TableCell>
                  <TableCell>{u.mobile ?? '—'}</TableCell>
                  <TableCell>{u.email ?? '—'}</TableCell>
                  <TableCell>{formatName(u.roleName)}</TableCell>
                  <TableCell
                    className={
                      unitLabel(u).startsWith('No ') ? 'text-rose-700 dark:text-rose-400' : ''
                    }
                  >
                    {unitLabel(u)}
                  </TableCell>
                  <TableCell>
                    {u.isActive ? (
                      <Badge variant="secondary">Active</Badge>
                    ) : (
                      <Badge variant="outline">Disabled</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setConfirmingId(null)
                          setEditingId(editingId === u.id ? null : u.id)
                        }}
                      >
                        {editingId === u.id ? 'Close' : 'Edit'}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          patchUser(
                            u.id,
                            { isActive: !u.isActive },
                            `${u.fullName} ${u.isActive ? 'disabled' : 'enabled'}`,
                          )
                        }
                      >
                        {u.isActive ? 'Disable' : 'Enable'}
                      </Button>
                      {confirmingId === u.id ? (
                        <>
                          <Button variant="destructive" size="sm" onClick={() => deleteUser(u)}>
                            Delete for good
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setConfirmingId(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => {
                            setEditingId(null)
                            setConfirmingId(u.id)
                          }}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
                {editingId === u.id ? (
                  <TableRow>
                    <TableCell colSpan={8} className="bg-muted/40">
                      <EditUser
                        user={u}
                        roles={roles}
                        roleItems={roleItems}
                        units={units}
                        unitItems={unitItems}
                        properties={properties}
                        users={users}
                        onCancel={() => setEditingId(null)}
                        onSave={async (patch) => {
                          await patchUser(u.id, patch, `${u.fullName} updated`)
                          setEditingId(null)
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ) : null}
                </Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

/**
 * The lodge / property picker, shown only for the two roles that have one.
 *
 * The shapes differ because the data does: a Lodge Manager holds exactly one lodge on their
 * own row, while properties each name their Banquet Manager, so one manager can hold several
 * (Regency covers Dipali Grand). Each property shows who holds it today — assigning it here
 * moves it, and a silent transfer is how two managers end up believing they own a hall.
 */
function ScopeFields({
  roleName,
  units,
  unitItems,
  properties,
  users,
  value,
  onChange,
}: {
  roleName: string
  units: Unit[]
  unitItems: { value: string; label: string }[]
  properties: Property[]
  users: User[]
  value: { lodgingUnitId: string; propertyIds: string[] }
  onChange: (patch: Partial<{ lodgingUnitId: string; propertyIds: string[] }>) => void
}) {
  if (roleName === 'lodge_manager') {
    return (
      <Field label="Lodge">
        <Select
          items={unitItems}
          value={value.lodgingUnitId}
          onValueChange={(v) => onChange({ lodgingUnitId: v ?? '' })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select a lodge" />
          </SelectTrigger>
          <SelectContent>
            {units.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    )
  }

  if (roleName === 'banquet_manager') {
    return (
      <div className="space-y-2 sm:col-span-2">
        <Label>Properties</Label>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {properties.map((p) => {
            const holder = users.find((x) => x.id === p.banquetManagerId)
            return (
              <label key={p.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={value.propertyIds.includes(p.id)}
                  onCheckedChange={(on) =>
                    onChange({
                      propertyIds: Boolean(on)
                        ? [...value.propertyIds, p.id]
                        : value.propertyIds.filter((id) => id !== p.id),
                    })
                  }
                />
                <span>{p.name}</span>
                {holder ? (
                  <span className="text-muted-foreground">held by {holder.fullName}</span>
                ) : null}
              </label>
            )
          })}
        </div>
      </div>
    )
  }

  return null
}

/** The inline edit form for one user. Role lives here so a role change and the unit it needs are saved together. */
function EditUser({
  user,
  roles,
  roleItems,
  units,
  unitItems,
  properties,
  users,
  onCancel,
  onSave,
}: {
  user: User
  roles: Role[]
  roleItems: { value: string; label: string }[]
  units: Unit[]
  unitItems: { value: string; label: string }[]
  properties: Property[]
  users: User[]
  onCancel: () => void
  onSave: (patch: Record<string, unknown>) => Promise<void>
}) {
  const [draft, setDraft] = useState({
    fullName: user.fullName,
    loginId: user.loginId,
    mobile: user.mobile ?? '',
    email: user.email ?? '',
    roleId: user.roleId,
    password: '',
    lodgingUnitId: user.lodgingUnitId ?? '',
    propertyIds: user.propertyIds,
  })
  const [saving, setSaving] = useState(false)
  const roleName = roles.find((r) => r.id === draft.roleId)?.name ?? ''

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const body: Record<string, unknown> = scopedBody(draft, roleName)
      if (!draft.password) delete body.password
      await onSave(body)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 py-2 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="Full name">
        <Input
          value={draft.fullName}
          onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
          required
        />
      </Field>
      <Field label="ID (this is their login)">
        <Input
          value={draft.loginId}
          onChange={(e) => setDraft({ ...draft, loginId: e.target.value })}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
      </Field>
      <Field label="Mobile (optional)">
        <Input
          value={draft.mobile}
          onChange={(e) => setDraft({ ...draft, mobile: e.target.value })}
        />
      </Field>
      <Field label="Email (optional)">
        <Input
          type="email"
          value={draft.email}
          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
        />
      </Field>
      <Field label="Role">
        <Select
          items={roleItems}
          value={draft.roleId}
          onValueChange={(v) =>
            setDraft({ ...draft, roleId: v ?? draft.roleId, lodgingUnitId: '', propertyIds: [] })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roles.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {formatName(r.name)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="New password (leave blank to keep)">
        <Input
          type="password"
          value={draft.password}
          onChange={(e) => setDraft({ ...draft, password: e.target.value })}
          minLength={8}
        />
      </Field>
      <ScopeFields
        roleName={roleName}
        units={units}
        unitItems={unitItems}
        properties={properties}
        users={users}
        value={draft}
        onChange={(patch) => setDraft({ ...draft, ...patch })}
      />
      <div className="flex items-end gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/**
 * Sends the scope that the chosen role can actually use, and an empty one for the roles that
 * cannot — so promoting a Lodge Manager to Booking Manager releases their lodge instead of
 * leaving it pointing at someone who no longer reads that board.
 */
function scopedBody(
  form: { lodgingUnitId: string; propertyIds: string[] } & Record<string, unknown>,
  roleName: string,
): Record<string, unknown> {
  return {
    ...form,
    lodgingUnitId: roleName === 'lodge_manager' ? form.lodgingUnitId || null : null,
    propertyIds: roleName === 'banquet_manager' ? form.propertyIds : [],
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  )
}
function formatName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
