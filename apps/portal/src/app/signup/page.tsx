import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { signupAction } from '../actions'

export default async function SignupPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const session = await getSession()
  const params = await searchParams
  const next = params.next && params.next.startsWith('/') ? params.next : '/'
  if (session) redirect(next)

  return (
    <main>
      <nav className="top">
        <Link className="brand" href="/">
          Aleph Portal
        </Link>
        <Link href={`/signin?next=${encodeURIComponent(next)}`}>Sign in</Link>
      </nav>
      <h1>Create account</h1>
      <p className="lead">Email and password. Used for MCP OAuth consent and Connector pairing.</p>
      <div className="card">
        {params.error ? <p className="error">{params.error}</p> : null}
        <form action={signupAction}>
          <input type="hidden" name="next" value={next} />
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
          <button type="submit">Sign up</button>
        </form>
      </div>
    </main>
  )
}
