import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { pairDevice } from '@/lib/devices'

export async function POST(request: Request): Promise<Response> {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }
  let body: { deviceId?: string }
  try {
    body = (await request.json()) as { deviceId?: string }
  } catch {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 })
  }
  try {
    const minted = await pairDevice({
      deviceId: String(body.deviceId ?? ''),
      workspaceId: session.workspaceId,
      userId: session.user.id
    })
    return NextResponse.json({
      token: minted.token,
      expiresAt: minted.expiresAt,
      deviceId: minted.deviceId,
      grantGeneration: minted.grantGeneration
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    )
  }
}
