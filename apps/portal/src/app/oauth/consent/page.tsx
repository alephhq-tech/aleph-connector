import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { parseReturnTo } from '@/lib/mcp-approve'
import { consentApproveAction } from '../../actions'

export default async function ConsentPage({
  searchParams
}: {
  searchParams: Promise<{ return_to?: string; error?: string }>
}) {
  const params = await searchParams
  const returnTo = params.return_to ?? ''
  const consentNext = `/oauth/consent?return_to=${encodeURIComponent(returnTo)}`
  const session = await getSession()
  if (!session) {
    redirect(`/signin?next=${encodeURIComponent(consentNext)}`)
  }

  let clientId = ''
  let redirectUri = ''
  let scope = ''
  let parseError = params.error
  if (returnTo) {
    try {
      const parsed = parseReturnTo(returnTo)
      clientId = parsed.clientId
      redirectUri = parsed.redirectUri
      scope = parsed.scope ?? 'cad:read cad:write cad:file'
    } catch (err) {
      parseError = err instanceof Error ? err.message : 'Invalid return_to'
    }
  } else {
    parseError = 'Missing return_to — start from an MCP client OAuth authorize request.'
  }

  return (
    <main>
      <nav className="top">
        <Link className="brand" href="/">
          Aleph Portal
        </Link>
        <span className="muted">{session.user.email}</span>
      </nav>
      <h1>Authorize MCP client</h1>
      <p className="lead">
        Allow this client to call Aleph Connector CAD tools for workspace {session.workspaceName}.
      </p>
      <div className="card stack">
        {parseError ? <p className="error">{parseError}</p> : null}
        <div>
          <div className="muted">Client</div>
          <strong>{clientId || '—'}</strong>
        </div>
        <div>
          <div className="muted">Redirect</div>
          <code>{redirectUri || '—'}</code>
        </div>
        <div>
          <div className="muted">Scopes</div>
          <code>{scope || '—'}</code>
        </div>
        {!parseError ? (
          <form action={consentApproveAction}>
            <input type="hidden" name="return_to" value={returnTo} />
            <div className="row">
              <button type="submit">Approve</button>
              <Link className="button secondary" href="/">
                Cancel
              </Link>
            </div>
          </form>
        ) : null}
      </div>
    </main>
  )
}
