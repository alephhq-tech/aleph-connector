import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { PairForm } from './pair-form'

export default async function PairPage() {
  const session = await getSession()
  if (!session) redirect('/signin?next=/devices/pair')

  return (
    <main>
      <nav className="top">
        <Link className="brand" href="/">
          Aleph Portal
        </Link>
        <Link href="/devices">Back to devices</Link>
      </nav>
      <h1>Pair Connector</h1>
      <p className="lead">
        Enter the <code>deviceId</code> from the CadAI Connector identity file, then copy the minted
        ABT back into that file.
      </p>
      <div className="card">
        <PairForm />
      </div>
    </main>
  )
}
