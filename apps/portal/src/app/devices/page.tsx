import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { listDevices } from '@/lib/devices'
import { revokeDeviceAction } from '../actions'

export default async function DevicesPage() {
  const session = await getSession()
  if (!session) redirect('/signin')
  const devices = await listDevices(session.workspaceId, session.user.id)

  return (
    <main>
      <nav className="top">
        <Link className="brand" href="/">
          Aleph Portal
        </Link>
        <Link href="/devices/pair">Pair device</Link>
      </nav>
      <h1>Devices</h1>
      <p className="lead">
        Paired Connectors for this workspace. MCP tools require exactly one active device for now.
      </p>
      <div className="card">
        {devices.length === 0 ? (
          <p className="muted">No paired devices yet.</p>
        ) : (
          <ul className="devices">
            {devices.map((d) => (
              <li key={d.deviceId}>
                <div>
                  <strong>{d.deviceId}</strong>
                  <div className="muted">generation {d.generation}</div>
                </div>
                <form action={revokeDeviceAction}>
                  <input type="hidden" name="deviceId" value={d.deviceId} />
                  <button type="submit" className="danger">
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}
