'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/http'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type Perm = { module: string; action: string }
type Role = { id: string; name: string; isSystem: boolean; userCount: number; permissions: Perm[] }
type RolesResponse = { roles: Role[]; modules: string[]; actions: string[] }

const ACTION_LABEL: Record<string, string> = {
  view: 'View',
  create_edit: 'Create / Edit',
  delete: 'Delete',
}

const permKey = (module: string, action: string) => `${module}:${action}`

export function RolesMatrix() {
  const [data, setData] = useState<RolesResponse | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [grid, setGrid] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [newRole, setNewRole] = useState('')

  async function load(selectAfter?: string) {
    const res = await api<RolesResponse>('/roles')
    setData(res)
    const pick = selectAfter ?? selectedId ?? res.roles[0]?.id ?? null
    setSelectedId(pick)
    const role = res.roles.find((r) => r.id === pick)
    setGrid(new Set(role?.permissions.map((p) => permKey(p.module, p.action)) ?? []))
  }

  useEffect(() => {
    // Initial fetch; state is set after the await, not during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load roles'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedRole = useMemo(
    () => data?.roles.find((r) => r.id === selectedId) ?? null,
    [data, selectedId],
  )

  const savedGrid = useMemo(
    () => new Set(selectedRole?.permissions.map((p) => permKey(p.module, p.action)) ?? []),
    [selectedRole],
  )
  const dirty = useMemo(
    () => grid.size !== savedGrid.size || [...grid].some((k) => !savedGrid.has(k)),
    [grid, savedGrid],
  )

  function selectRole(role: Role) {
    setSelectedId(role.id)
    setGrid(new Set(role.permissions.map((p) => permKey(p.module, p.action))))
  }

  function toggle(module: string, action: string) {
    setGrid((prev) => {
      const next = new Set(prev)
      const k = permKey(module, action)
      if (next.has(k)) next.delete(k)
      else {
        next.add(k)
        // Create/Edit or Delete without View is meaningless — a user must see a module
        // to act on it. Imply View so the matrix can't express an unreachable grant.
        if (action !== 'view') next.add(permKey(module, 'view'))
      }
      return next
    })
  }

  async function save() {
    if (!selectedRole) return
    setSaving(true)
    try {
      const permissions = [...grid].map((k) => {
        const [module, action] = k.split(':')
        return { module, action }
      })
      await api(`/roles/${selectedRole.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissions }),
      })
      toast.success(`Permissions saved for ${selectedRole.name}`)
      await load(selectedRole.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function createRole() {
    const name = newRole.trim()
    if (!name) return
    try {
      const { role } = await api<{ role: Role }>('/roles', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      setNewRole('')
      toast.success(`Role "${name}" created`)
      await load(role.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create role')
    }
  }

  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-wrap gap-2">
          {data.roles.map((role) => (
            <button
              key={role.id}
              type="button"
              onClick={() => selectRole(role)}
              className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                role.id === selectedId
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-muted'
              }`}
            >
              {formatName(role.name)}
              <span className="ml-2 opacity-70">{role.userCount}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-end gap-2">
          <Input
            placeholder="New role name"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createRole()}
            className="w-44"
          />
          <Button variant="outline" onClick={createRole} disabled={!newRole.trim()}>
            Add role
          </Button>
        </div>
      </div>

      {selectedRole && (
        <>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-medium">{formatName(selectedRole.name)}</h2>
            {selectedRole.isSystem && <Badge variant="secondary">system</Badge>}
            <div className="ml-auto flex items-center gap-3">
              {dirty && <span className="text-sm text-amber-600">Unsaved changes</span>}
              <Button onClick={save} disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save permissions'}
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-64">Module</TableHead>
                  {data.actions.map((a) => (
                    <TableHead key={a} className="text-center">
                      {ACTION_LABEL[a] ?? a}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.modules.map((module) => (
                  <TableRow key={module}>
                    <TableCell className="font-medium">{formatModule(module)}</TableCell>
                    {data.actions.map((action) => (
                      <TableCell key={action} className="text-center">
                        <Checkbox
                          checked={grid.has(permKey(module, action))}
                          onCheckedChange={() => toggle(module, action)}
                          aria-label={`${formatModule(module)} ${action}`}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  )
}

function formatName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
function formatModule(code: string): string {
  return code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
