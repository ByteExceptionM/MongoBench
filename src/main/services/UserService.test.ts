import { describe, expect, it } from 'vitest'
import { ObjectId } from 'bson'
import type { ConnectionService } from './ConnectionService'
import { UserService } from './UserService'

function serviceReturning(reply: Record<string, unknown>): {
  service: UserService
  calls: Array<{ db: string; command: Record<string, unknown> }>
} {
  const calls: Array<{ db: string; command: Record<string, unknown> }> = []
  const connections = {
    getClient: () => ({
      db: (db: string) => ({
        command: async (command: Record<string, unknown>) => {
          calls.push({ db, command })
          return reply
        }
      })
    })
  } as unknown as ConnectionService
  return { service: new UserService(connections), calls }
}

describe('UserService.listUsers', () => {
  it('returns customData as relaxed EJSON so it survives structured clone', async () => {
    const id = new ObjectId('64b7f0c2a1b2c3d4e5f60718')
    const { service } = serviceReturning({
      users: [
        {
          user: 'svc',
          db: 'shop',
          roles: [{ role: 'read', db: 'shop' }],
          customData: { owner: id, since: new Date('2024-01-02T03:04:05.678Z') }
        }
      ]
    })
    const [user] = await service.listUsers('c1', 'shop')
    expect(user?.customData).toEqual({
      owner: { $oid: '64b7f0c2a1b2c3d4e5f60718' },
      since: { $date: '2024-01-02T03:04:05.678Z' }
    })
  })

  it('leaves customData out when the user has none', async () => {
    const { service } = serviceReturning({ users: [{ user: 'svc', db: 'shop' }] })
    expect(await service.listUsers('c1', 'shop')).toEqual([{ user: 'svc', db: 'shop', roles: [] }])
  })
})

describe('UserService.listRoles', () => {
  it('runs rolesInfo with built-in roles on the given db', async () => {
    const { service, calls } = serviceReturning({ roles: [] })
    await service.listRoles('c1', 'shop')
    expect(calls).toEqual([{ db: 'shop', command: { rolesInfo: 1, showBuiltinRoles: true } }])
  })

  it('maps the reported roles and flags built-ins', async () => {
    const { service } = serviceReturning({
      roles: [
        { role: 'read', db: 'shop', isBuiltin: true, roles: [], inheritedRoles: [] },
        { role: 'orderClerk', db: 'shop', isBuiltin: false },
        { role: 'legacy', db: 'shop' }
      ]
    })
    expect(await service.listRoles('c1', 'shop')).toEqual([
      { role: 'read', db: 'shop', isBuiltin: true },
      { role: 'orderClerk', db: 'shop', isBuiltin: false },
      { role: 'legacy', db: 'shop', isBuiltin: false }
    ])
  })

  it('returns an empty list when the server reports no roles field', async () => {
    const { service } = serviceReturning({ ok: 1 })
    expect(await service.listRoles('c1', 'shop')).toEqual([])
  })
})
