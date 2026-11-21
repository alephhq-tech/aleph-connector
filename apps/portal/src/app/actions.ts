'use server'

import { redirect } from 'next/navigation'
import {
  createUserWithWorkspace,
  destroySession,
  getSession,
  signIn
} from '@/lib/auth'
import { revokeDevice } from '@/lib/devices'
import { approveViaMcp, parseReturnTo } from '@/lib/mcp-approve'

export async function signupAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')
  const next = String(formData.get('next') ?? '/')
  const safeNext = next.startsWith('/') ? next : '/'
  try {
    await createUserWithWorkspace(email, password)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Signup failed'
    redirect(`/signup?next=${encodeURIComponent(safeNext)}&error=${encodeURIComponent(message)}`)
  }
  redirect(safeNext)
}

export async function signinAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')
  const next = String(formData.get('next') ?? '/')
  const safeNext = next.startsWith('/') ? next : '/'
  try {
    await signIn(email, password)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sign in failed'
    redirect(`/signin?next=${encodeURIComponent(safeNext)}&error=${encodeURIComponent(message)}`)
  }
  redirect(safeNext)
}

export async function signoutAction(): Promise<void> {
  await destroySession()
  redirect('/signin')
}

export async function consentApproveAction(formData: FormData): Promise<void> {
  const returnTo = String(formData.get('return_to') ?? '')
  const consentPath = `/oauth/consent?return_to=${encodeURIComponent(returnTo)}`
  const session = await getSession()
  if (!session) {
    redirect(`/signin?next=${encodeURIComponent(consentPath)}`)
  }
  let redirectTo: string
  try {
    const params = parseReturnTo(returnTo)
    ;({ redirectTo } = await approveViaMcp({
      ...params,
      userId: session.user.id,
      workspaceId: session.workspaceId
    }))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Consent failed'
    redirect(`${consentPath}&error=${encodeURIComponent(message)}`)
  }
  redirect(redirectTo)
}

export async function revokeDeviceAction(formData: FormData): Promise<void> {
  const session = await getSession()
  if (!session) redirect('/signin')
  const deviceId = String(formData.get('deviceId') ?? '')
  await revokeDevice(deviceId, session.workspaceId, session.user.id)
  redirect('/devices')
}
