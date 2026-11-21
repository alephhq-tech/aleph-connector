import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { listDevices } from '@/lib/devices'
import { signoutAction } from './actions'

export default async function HomePage() {
  const session = await getSession()
  if (!session) redirect('/signin')
  const devices = await listDevices(session.workspaceId, session.user.id)

  return (
    <main>
      <nav className="top">
        <Link className="brand" href="/">
          Aleph Portal
        </Link>
        <form action={signoutAction}>
          <button type="submit" className="secondary">
            Sign out
          </button>
        </form>
      </nav>
      <h1>Workspace</h1>
      <p className="lead">
        Signed in as {session.user.email}. Pair a Connector, then approve MCP clients when they ask.
      </p>
      <div className="card stack">
        <div>
          <div className="muted">Workspace</div>
          <strong>{session.workspaceName}</strong>
          <div className="muted">{session.workspaceId}</div>
        </div>
        <div>
          <div className="muted">Paired devices</div>
          <strong>{devices.length}</strong>
        </div>
        <div className="row">
          <Link className="button" href="/devices">
            Manage devices
          </Link>
          <Link className="button secondary" href="/devices/pair">
            Pair Connector
          </Link>
        </div>
      </div>
    </main>
  )
}
