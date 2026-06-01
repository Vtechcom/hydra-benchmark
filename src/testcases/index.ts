/**
 * Testcase manifest. Import every testcase here so it registers itself, then
 * register them in the global registry. Adding a testcase = create its folder
 * under `src/testcases/<name>/` and add two lines below.
 */
import { register } from '../core/registry'
import { perpState } from './perp-state/index'
import { noopTransfer } from './noop-transfer/index'

register(perpState)
register(noopTransfer)
