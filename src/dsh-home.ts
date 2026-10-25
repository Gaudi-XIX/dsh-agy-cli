import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * DSH data root. `$DSH_HOME` wins so the home follows the desktop shell's
 * relocation; plugins must not hardcode `~/.dsh` below this helper.
 */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}
