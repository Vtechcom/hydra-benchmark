/**
 * Print the in-head funding address derived from `BENCH_MNEMONIC`.
 * Used to seed `infra/preprod-offline/utxo-1.json` — the head's initial UTxO must
 * sit at this address or every testcase fails with `no spendable UTxO at <addr>`.
 */
import dotenv from 'dotenv'
dotenv.config()
import { AppWallet, NETWORK_ID } from '@hydra-sdk/core'

const DEFAULT_MNEMONIC =
	'aim betray remove party capable tiny model fashion relax room august always melody eye diamond cinnamon mother advice blanket earn garden copy empower symptom'

const words = (process.env.BENCH_MNEMONIC || DEFAULT_MNEMONIC).split(' ')
const account = new AppWallet({ key: { type: 'mnemonic', words }, networkId: NETWORK_ID.PREPROD }).getAccount(0, 0)
console.log(account.baseAddressBech32)
