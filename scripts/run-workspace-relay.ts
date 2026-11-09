/** Start the self-hosted sharing relay. TLS terminates at the configured reverse proxy. */
import { readFile } from 'node:fs/promises'
import { runWorkspaceRelay } from '../src/sharing/relay.js'

async function mobilePage(): Promise<string> {
  try {
    // Build-time virtual asset; no CDN or runtime source checkout required.
    // @ts-expect-error virtual module exists only during relay bundling
    return (await import('sakura-share-mobile-embed')).default as string
  } catch { return readFile(new URL('../src/web/mobile.html', import.meta.url), 'utf8') }
}

try {
  const relay = await runWorkspaceRelay({
    registrationToken: process.env.SAKURA_RELAY_REGISTRATION_TOKEN ?? '',
    host: process.env.SAKURA_RELAY_HOST ?? '127.0.0.1',
    port: process.env.SAKURA_RELAY_PORT === undefined ? 8787 : Number(process.env.SAKURA_RELAY_PORT),
    publicOrigin: process.env.SAKURA_RELAY_PUBLIC_ORIGIN,
    mobileHtml: await mobilePage(),
  })
  console.log('SakuraCode workspace relay ready at ' + relay.url)
  console.log('No workspace is shared until its desktop operator explicitly starts a connection.')
  let stopping = false
  const stop = async () => { if (stopping) return; stopping = true; await relay.close() }
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
} catch {
  console.error('Relay startup failed. Check HTTPS origin, host/port and SAKURA_RELAY_REGISTRATION_TOKEN (32–256 random characters).')
  process.exitCode = 1
}
