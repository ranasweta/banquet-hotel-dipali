'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
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
  mobile: string
  email: string | null
  isActive: boolean
  roleId: string
  roleName: string
}
type Role = { id: string; name: string }

const blankForm = { fullName: '', mobile: '', email: '', roleId: '', password: '' }

export function UsersAdmin() {
  const [users, setUsers] = useState<User[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [form, setForm] = useState(blankForm)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [{ users }, { roles }] = await Promise.all([
      api<{ users: User[] }>('/users'),
      api<{ roles: Role[] }>('/roles'),
    ])
    setUsers(users)
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
      await api('/users', { method: 'POST', body: JSON.stringify(form) })
      toast.success(`${form.fullName} added`)
      setForm(blankForm)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create user')
    } finally {
      setCreating(false)
    }
  }

  async function patchUser(id: string, patch: Partial<Pick<User, 'roleId' | 'isActive'>>, label: string) {
    try {
      await api(`/users/${id}`, { method: 'PUT', body: JSON.stringify(patch) })
      toast.success(label)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    }
  }

  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? ''
  // base-ui Select renders the raw value in the trigger unless Root is given an items
  // map to resolve each value to its label. Without this the trigger shows the role's
  // UUID instead of its name.
  const roleItems = roles.map((r) => ({ value: r.id, label: formatName(r.name) }))

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
            <Field label="Mobile">
              <Input
                value={form.mobile}
                onChange={(e) => setForm({ ...form, mobile: e.target.value })}
                required
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
                onValueChange={(v) => setForm({ ...form, roleId: v ?? '' })}
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
              <TableHead>Mobile</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : (
              users.map((u) => (
                <TableRow key={u.id} className={u.isActive ? '' : 'opacity-60'}>
                  <TableCell className="font-medium">{u.fullName}</TableCell>
                  <TableCell>{u.mobile}</TableCell>
                  <TableCell>{u.email ?? '—'}</TableCell>
                  <TableCell>
                    <Select
                      items={roleItems}
                      value={u.roleId}
                      onValueChange={(v) => {
                        if (v && v !== u.roleId) {
                          patchUser(u.id, { roleId: v }, `${u.fullName} is now ${formatName(roleName(v))}`)
                        }
                      }}
                    >
                      <SelectTrigger className="w-44">
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
                  </TableCell>
                  <TableCell>
                    {u.isActive ? (
                      <Badge variant="secondary">Active</Badge>
                    ) : (
                      <Badge variant="outline">Disabled</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
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
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
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
