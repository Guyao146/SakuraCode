/** Exercise the actual row menu rather than clicking hidden legacy inline controls. */
import type { BrowserClient } from './browser-client.js'

export async function openSessionMenu(browser: BrowserClient, id?: string): Promise<void> {
  await browser.click(id ? `[data-session-id=${JSON.stringify(id)}] .session-more` : '.session-item .session-more')
  await browser.waitFor("document.getElementById('sessionContextMenu').matches(':popover-open') && document.querySelector('#sessionContextMenu [role=menuitem]')")
}

export async function sessionAction(browser: BrowserClient, action: 'export' | 'rename' | 'archive' | 'delete', id?: string): Promise<void> {
  await openSessionMenu(browser, id)
  await browser.click(`#sessionContextMenu [data-session-action=${action}]`)
}