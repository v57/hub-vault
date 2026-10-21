import { Service } from 'hub-service'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { serveVault } from './api'
import { Mailbox } from './mailbox'

/**
 * hub-vault: end-to-end-encrypted record envelopes kept for each of a vault's devices until it has them, so v57's
 * Vault syncs between devices through the user's own Hub. Data in `HUB_VAULT_DATA` (default `./data`).
 */
const directory = process.env.HUB_VAULT_DATA ?? join(process.cwd(), 'data')
mkdirSync(directory, { recursive: true })
const mailbox = new Mailbox(join(directory, 'vault.sqlite'))
const service = new Service({ name: 'Vault', icon: { symbol: 'lock.shield', text: 'V' } })
serveVault(service, mailbox)
service.start()
