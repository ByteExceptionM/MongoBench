import type { Document } from 'mongodb'
import type { ConnectionService } from './ConnectionService'
import type { DatabaseUser, DatabaseUserRole } from '@shared/types'

export class UserService {
  constructor(private readonly connections: ConnectionService) {}

  async listUsers(connectionId: string, db: string): Promise<DatabaseUser[]> {
    const client = this.connections.getClient(connectionId)
    const result = (await client.db(db).command({ usersInfo: 1 })) as {
      users?: Array<{
        user: string
        db: string
        roles?: DatabaseUserRole[]
        customData?: Document
        mechanisms?: string[]
      }>
    }
    return (result.users ?? []).map((u) => ({
      user: u.user,
      db: u.db,
      roles: u.roles ?? [],
      ...(u.customData !== undefined ? { customData: u.customData } : {}),
      ...(u.mechanisms !== undefined ? { mechanisms: u.mechanisms } : {})
    }))
  }

  async createUser(
    connectionId: string,
    db: string,
    username: string,
    password: string,
    roles: DatabaseUserRole[]
  ): Promise<void> {
    const client = this.connections.getClient(connectionId)
    await client.db(db).command({
      createUser: username,
      pwd: password,
      roles
    })
  }

  async updateUser(
    connectionId: string,
    db: string,
    username: string,
    password: string | null,
    roles: DatabaseUserRole[] | null
  ): Promise<void> {
    const client = this.connections.getClient(connectionId)
    const cmd: Record<string, unknown> = { updateUser: username }
    if (password !== null) cmd['pwd'] = password
    if (roles !== null) cmd['roles'] = roles
    await client.db(db).command(cmd)
  }

  async dropUser(connectionId: string, db: string, username: string): Promise<void> {
    const client = this.connections.getClient(connectionId)
    await client.db(db).command({ dropUser: username })
  }
}
