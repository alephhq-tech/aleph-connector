import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { signinAction } from '../actions'

export default async function SigninPage({
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
        <Link href={`/signup?next=${encodeURIComponent(next)}`}>Sign up</Link>
      </nav>
      <h1>Sign in</h1>
      <p className="lead">Continue to your workspace, OAuth consent, or device pairing.</p>
      <div className="card">
        {params.error ? <p className="error">{params.error}</p> : null}
        <form action={signinAction}>
          <input type="hidden" name="next" value={next} />
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <button type="submit">Sign in</button>
        </form>
      </div>
    </main>
  )
}
