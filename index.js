// dsh-mastery — host half.
//
// Owns two things the browser half cannot do itself:
//   1. SKILL discovery. Each chip stands for one bundle (a directory that contains one or
//      more `SKILL.md` documents). Discovery walks that directory, parses the YAML
//      frontmatter and keeps the body in memory.
//   2. Per-session activation. Toggling a chip registers every skill of that bundle into
//      THAT agent's layer (`agent.ctx.skills.register`), so the skill catalog the model
//      receives is changed for this chat only. The disposer removes it again.
//
// Why registration and not a system-prompt injection: the shipped `skill` tool reads the
// same registry (`ctx.skills.list` / `ctx.skills.get` with `scope: exec.agent`), so a skill
// registered into the agent layer becomes a real, loadable skill — the model sees it in
// `<available_skills>` and can pull the full body with one tool call.
//
// The browser half (<DSH_HOME> runtime route `/dsh-mastery/*`) only reads state and asks
// for toggles; all filesystem work stays here.

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeRepository, fetchRepository, gitError, isGitCheckout, pullRepository } from './lib/git.js'

/** Cordis plugin name. */
export const name = 'dsh-mastery'
/**
 * `webServer` carries the GUI, `skills` is the registry we write into, `agents` resolves a
 * session id to its live agent (and therefore to its scope), `tools` exposes `skill_rail`,
 * `workingDirectory` gives the same cwd the `skill` tool passes when it looks up skills.
 */
export const inject = ['webServer', 'skills', 'agents', 'tools', 'workingDirectory']

const ROUTE_PREFIX = '/dsh-mastery'
/** Plugin data directory under DSH_HOME. */
const STORE_DIR = 'mastery'
/** The pre-rename data directory. Moved into place on first mount, so switches survive. */
const LEGACY_STORE_DIR = 'skillrail'
const CONFIG_FILE = 'config.json'
const STATE_FILE = 'state.json'
const UPDATES_FILE = 'updates.json'
const CONFIG_VERSION = 2
const STATE_VERSION = 1
const UPDATES_VERSION = 1

/** Provider/source tags recorded on every skill we register, so it is attributable. */
const PROVIDER = 'mastery'
const SOURCE = 'custom'

/**
 * The plugin's own directory. One bundle ships inside the package (`skills/assay`) instead of a
 * clone, so on every machine — including a fresh install and CI — that chip is always present.
 */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * Update-check defaults. `autoCheck` fetches in the background on mount (git is cheap, and a
 * stale badge is worse than none); `autoPull` stays off because a fast-forward rewrites what the
 * model reads the next time a chip is switched on.
 */
const DEFAULT_UPDATES = { autoCheck: true, autoPull: false, intervalHours: 6, timeoutSeconds: 60 }

/** Read the `updates` block of config.json defensively; unknown keys are ignored. */
function mergeUpdateSettings(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const settings = { ...DEFAULT_UPDATES }
  if (typeof input.autoCheck === 'boolean') settings.autoCheck = input.autoCheck
  if (typeof input.autoPull === 'boolean') settings.autoPull = input.autoPull
  if (typeof input.intervalHours === 'number' && Number.isFinite(input.intervalHours) && input.intervalHours > 0) {
    settings.intervalHours = input.intervalHours
  }
  if (typeof input.timeoutSeconds === 'number' && Number.isFinite(input.timeoutSeconds) && input.timeoutSeconds >= 5) {
    settings.timeoutSeconds = input.timeoutSeconds
  }
  return settings
}

/**
 * One sentence about a bundle's source: where it comes from, how far behind it is, and whether
 * the answer is fresh. Shared by the tool output and the chip title so the two cannot disagree.
 */
function describeUpdate(record) {
  if (record === null || record === undefined) return 'source not checked yet'
  if (record.local === true) return 'authored in this package — there is no upstream to check'
  if (record.git !== true) return `not a git checkout (${record.root})`
  const remote =
    typeof record.upstream === 'string' && record.upstream !== ''
      ? record.upstream
      : typeof record.remoteUrl === 'string' && record.remoteUrl !== ''
        ? record.remoteUrl
        : 'no upstream'
  let distance
  if (record.error !== null && record.error !== undefined) distance = `check failed: ${record.error}`
  else if (typeof record.behind !== 'number') distance = 'status unknown'
  else if (record.behind > 0) distance = `${record.behind} commit${record.behind === 1 ? '' : 's'} behind ${remote}`
  else if (typeof record.ahead === 'number' && record.ahead > 0) {
    distance = `even with ${remote} (${record.ahead} local commit${record.ahead === 1 ? '' : 's'} not pushed)`
  } else distance = `up to date with ${remote}`
  const head = record.head !== null && record.head !== undefined && typeof record.head.short === 'string' ? record.head : null
  const headDate = head !== null && typeof head.date === 'string' ? head.date.slice(0, 10) : ''
  const at = head === null ? '' : ` @ ${head.short}${headDate === '' ? '' : ` (${headDate})`}`
  const dirty = record.dirty === true ? `, ${record.dirtyFiles} edited file${record.dirtyFiles === 1 ? '' : 's'} locally` : ''
  const freshness = record.fetched === false ? ' — from the last fetch, not a fresh check' : ''
  return `${distance}${at}${dirty}${freshness}`
}

/** Kebab-case, identical to the rule the harness enforces on skill names. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Walk limits: a skill directory is small, but a repo root can hold gigabytes of assets. */
const MAX_WALK_DEPTH = 6
const MAX_WALK_FILES = 8000
const MAX_SKILL_FILE_BYTES = 512 * 1024
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.svn', 'dist', 'build', 'out', 'vendor', '__pycache__'])

const MAX_BODY_BYTES = 256 * 1024

/** Base directory the source clones live in when the plugin is used on this machine. */
/**
 * Where the cloned bundles are looked for when config.json says nothing. `DSH_MASTERY_SOURCES`
 * overrides the base wholesale; otherwise new installs get `<DSH_HOME>/mastery/sources`, and the
 * README's clone commands put the repositories there. An existing config.json wins over both,
 * so a machine that already points at clones elsewhere is left alone.
 */
const DEFAULT_SOURCE_BASE =
  (process.env.DSH_MASTERY_SOURCES || '').trim() !== '' ? (process.env.DSH_MASTERY_SOURCES || '').trim() : join(dshHome(), STORE_DIR, 'sources')

/**
 * The chips. `root` is a directory to scan; every `SKILL.md` below it becomes part of the bundle.
 * Order here is the order of the chips. `local: true` marks a bundle that is authored here and
 * shipped inside the package: it has no git history of its own, so `updates` reports it instead
 * of fetching, and `update` leaves it alone.
 */
const DEFAULT_BUNDLES = [
  {
    id: '3dviz',
    label: '3Dviz',
    title: '3Dviz Pro Max',
    blurb: 'Expressive 3D scenes, explainers and interactive models',
    root: join(DEFAULT_SOURCE_BASE, '3dviz-pro-max'),
  },
  {
    id: 'antislop',
    label: 'Anti-Slop',
    title: 'Anti-Slop',
    blurb: 'The core filter plus its code, copy, layout, UI and human-writing variants',
    root: join(DEFAULT_SOURCE_BASE, 'Anti-Slop'),
  },
  {
    id: 'uiux',
    label: 'UI/UX',
    title: 'UI/UX Pro Max',
    blurb: 'Design intelligence: styles, palettes, typography, UX rules, charts',
    root: join(DEFAULT_SOURCE_BASE, 'ui-ux-pro-max-skill'),
  },
  {
    id: 'assay',
    label: 'Assay',
    title: 'Assay',
    blurb: 'Depth of reasoning, verified claims and honest delivery for work that has consequences',
    root: join(PACKAGE_ROOT, 'skills', 'assay'),
    local: true,
  },
]

/**
 * Append the bundles a config file written by an older release has never seen. `version` is the
 * marker: the append happens exactly once, on the bump, so a bundle the user removed on purpose
 * stays removed instead of reappearing on every mount.
 */
function upgradeConfig(version, rawBundles) {
  const known = typeof version === 'number' && Number.isFinite(version) ? version : 0
  if (known >= CONFIG_VERSION) return rawBundles
  const present = new Set(rawBundles.map((entry) => entry && entry.id))
  return [...rawBundles, ...DEFAULT_BUNDLES.filter((bundle) => !present.has(bundle.id))]
}

/** Whether a config row can be resolved at all; a malformed row is skipped, never fatal. */
function usableEntry(entry) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.id === 'string' &&
    entry.id !== '' &&
    typeof entry.root === 'string' &&
    entry.root.trim() !== ''
  )
}

/** A config row reduced to the fields the rest of the plugin reads. */
function toBundleEntry(entry) {
  return {
    id: entry.id,
    label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.id,
    title: typeof entry.title === 'string' ? entry.title : undefined,
    blurb: typeof entry.blurb === 'string' ? entry.blurb : '',
    root: entry.root,
    // `local` marks a bundle that ships inside the package, so it owns no git history.
    local: entry.local === true,
  }
}

/**
 * The description of a source that owns no git state at all — a bundle shipped inside the
 * package. Written out rather than fetched so the update record has the same shape everywhere.
 */
const EMPTY_DESCRIPTION = {
  git: false,
  branch: null,
  upstream: null,
  remoteUrl: null,
  head: null,
  upstreamHead: null,
  behind: null,
  ahead: null,
  dirty: false,
  dirtyFiles: 0,
}

/** An error that already knows the HTTP status it must be reported with. */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** Absolute directory that holds plugin data, resolving DSH_HOME the same way the harness does. */
function dshHome() {
  const fromEnv = (process.env.DSH_HOME || '').trim()
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

function storeDirectory() {
  return join(dshHome(), STORE_DIR)
}

/**
 * The plugin used to be called Skillrail and kept its switches in `<DSH_HOME>/skillrail`.
 * Renaming the directory on first mount is the only way a user keeps their per-chat state; when
 * both directories exist the old one is left untouched instead of being merged, because two
 * state files cannot be reconciled without guessing.
 */
async function migrateLegacyStore(directory) {
  const legacy = join(dshHome(), LEGACY_STORE_DIR)
  if (dirname(directory) !== dirname(legacy) || directory === legacy) return null
  if (!(await pathExists(legacy))) return null
  if (await pathExists(directory)) {
    return `both ${LEGACY_STORE_DIR}/ and ${STORE_DIR}/ exist; using ${STORE_DIR}/ and leaving the old directory alone`
  }
  try {
    await rename(legacy, directory)
    return `moved ${legacy} to ${directory}`
  } catch (error) {
    return `could not move ${legacy}: ${error && error.message ? error.message : String(error)}`
  }
}

async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ discovery */

/**
 * Parse `name` / `description` out of a SKILL.md frontmatter block.
 * Supports plain scalars, quoted scalars and the folded (`>`) / literal (`|`) blocks the
 * three source repositories use.
 */
function parseFrontmatter(text) {
  const values = {}
  // `\r` alone is a line terminator for `.` and `$`, so a CRLF file whose last frontmatter
  // line has a dangling `\r` would silently drop that key. Split on all three forms.
  const lines = text.split(/\r\n|\n|\r/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    const raw = match[2].trim()
    if (raw === '>' || raw === '>-' || raw === '|' || raw === '|-') {
      const block = []
      let cursor = index + 1
      for (; cursor < lines.length; cursor += 1) {
        const next = lines[cursor]
        if (next.trim() === '') {
          block.push('')
          continue
        }
        if (!/^\s/.test(next)) break
        block.push(next.trim())
      }
      index = cursor - 1
      values[key] = raw.startsWith('|') ? block.join('\n').trim() : block.filter((part) => part !== '').join(' ')
      continue
    }
    let value = raw
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

/** Split one SKILL.md into frontmatter metadata plus the instruction body. */
function parseSkillDocument(text) {
  const normalized = text.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return null
  const closing = normalized.indexOf('\n---', 3)
  if (closing < 0) return null
  const meta = parseFrontmatter(normalized.slice(3, closing))
  const afterFence = normalized.indexOf('\n', closing + 1)
  const content = afterFence < 0 ? '' : normalized.slice(afterFence + 1).replace(/^\s*\n/, '')
  const skillName = String(meta.name || '').trim()
  const description = String(meta.description || '').trim()
  if (skillName === '' || description === '') return null
  return { name: skillName, description, content }
}

/**
 * Breadth-first search for `SKILL.md` files. The canonical `.claude/skills` copy of a skill
 * wins over the duplicated `cli/assets/skills` copy: files are ordered so any path that
 * contains `.claude/skills` comes first, and the caller keeps the first name it sees.
 */
async function findSkillFiles(root) {
  const found = []
  let visited = 0
  let frontier = [{ directory: root, depth: 0 }]
  while (frontier.length > 0) {
    const next = []
    for (const entry of frontier) {
      let children
      try {
        children = await readdir(entry.directory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        visited += 1
        if (visited > MAX_WALK_FILES) return rankSkillFiles(found)
        const absolute = join(entry.directory, child.name)
        if (child.isDirectory()) {
          if (SKIP_DIRECTORIES.has(child.name)) continue
          // `.claude/skills` is the canonical skill root of a Claude-style repo, so it is the
          // one dot directory we follow; every other hidden directory stays out of the walk.
          if (child.name.startsWith('.') && child.name !== '.claude') continue
          if (entry.depth + 1 > MAX_WALK_DEPTH) continue
          next.push({ directory: absolute, depth: entry.depth + 1 })
          continue
        }
        if (!child.isFile()) continue
        if (child.name !== 'SKILL.md') continue
        found.push(absolute)
      }
    }
    frontier = next
  }
  return rankSkillFiles(found)
}

function rankSkillFiles(files) {
  return files.slice().sort((left, right) => {
    const leftCanonical = left.includes('.claude/skills') || left.includes('.claude\\skills') ? 0 : 1
    const rightCanonical = right.includes('.claude/skills') || right.includes('.claude\\skills') ? 0 : 1
    if (leftCanonical !== rightCanonical) return leftCanonical - rightCanonical
    return left.localeCompare(right)
  })
}

/** Read every skill of one bundle. Never throws: a broken document becomes a warning. */
async function resolveBundle(bundle) {
  const resolved = {
    id: bundle.id,
    label: bundle.label,
    title: bundle.title || bundle.label,
    blurb: bundle.blurb || '',
    root: bundle.root,
    local: bundle.local === true,
    present: false,
    skills: [],
    warnings: [],
    error: undefined,
  }
  if (!(await pathExists(bundle.root))) {
    resolved.error = `source directory not found: ${bundle.root}`
    return resolved
  }
  resolved.present = true
  const files = await findSkillFiles(bundle.root)
  const seen = new Set()
  for (const file of files) {
    let text
    try {
      const info = await stat(file)
      if (info.size > MAX_SKILL_FILE_BYTES) {
        resolved.warnings.push(`${file}: larger than ${MAX_SKILL_FILE_BYTES} bytes, skipped`)
        continue
      }
      text = await readFile(file, 'utf8')
    } catch (error) {
      resolved.warnings.push(`${file}: ${error && error.message ? error.message : String(error)}`)
      continue
    }
    const parsed = parseSkillDocument(text)
    if (parsed === null) {
      resolved.warnings.push(`${file}: no usable name/description frontmatter`)
      continue
    }
    if (!SKILL_NAME.test(parsed.name)) {
      resolved.warnings.push(`${file}: "${parsed.name}" is not a kebab-case skill name`)
      continue
    }
    if (seen.has(parsed.name)) continue
    seen.add(parsed.name)
    resolved.skills.push({
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      directory: dirname(file),
      file,
    })
  }
  if (resolved.skills.length === 0) resolved.error = `no SKILL.md found under ${bundle.root}`
  return resolved
}

/* ------------------------------------------------------------------ plugin body */

export function apply(ctx) {
  const directory = storeDirectory()
  const disposers = []

  /** Persisted intent: one set of bundle ids per session id. */
  const desired = new Map()
  /** Persisted evidence of use: session id -> skill name -> number of `skill` loads. */
  const usage = new Map()
  /** Live registrations: one entry per session id we have touched in this process. */
  const live = new Map()
  /** Last known update status per bundle id; persisted so a badge survives a restart. */
  const updates = new Map()
  let updatesCheckedAt = null
  let updatesLoaded = false
  /** Merged over DEFAULT_UPDATES by loadConfig(). */
  let updateSettings = { ...DEFAULT_UPDATES }

  let catalogPromise = null
  /** skill name -> bundle id, rebuilt with the catalog so the usage listener stays synchronous. */
  let nameIndex = new Map()
  let stateLoaded = false
  let saveTimer = null
  let saveChain = Promise.resolve()
  /** Resolved once the pre-rename directory has been dealt with; every disk read waits on it. */
  const migration = migrateLegacyStore(directory)

  const log = (...parts) => console.log('[dsh-mastery]', ...parts)

  migration.then(
    (note) => {
      if (note !== null) log(note)
    },
    () => {},
  )

  /* --------------------------------------------------------- persistence */

  async function loadState() {
    if (stateLoaded) return
    stateLoaded = true
    await migration.catch(() => null)
    const file = join(directory, STATE_FILE)
    try {
      const text = await readFile(file, 'utf8')
      const parsed = JSON.parse(text)
      const sessions = parsed && parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
      for (const [sessionId, entry] of Object.entries(sessions)) {
        const ids = entry && Array.isArray(entry.bundles) ? entry.bundles.filter((id) => typeof id === 'string') : []
        desired.set(sessionId, new Set(ids))
        const recorded = entry && entry.usage && typeof entry.usage === 'object' ? entry.usage : {}
        const counts = new Map()
        for (const [skillName, count] of Object.entries(recorded)) {
          if (typeof count === 'number' && Number.isFinite(count) && count > 0) counts.set(skillName, Math.floor(count))
        }
        if (counts.size > 0) usage.set(sessionId, counts)
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') log('could not read state file:', error.message || String(error))
    }
  }

  function serializeState() {
    const sessions = {}
    const ids = new Set([...desired.keys(), ...usage.keys()])
    for (const sessionId of ids) {
      const bundles = [...(desired.get(sessionId) || [])].sort()
      const counts = Object.fromEntries([...(usage.get(sessionId) || [])].sort(([left], [right]) => left.localeCompare(right)))
      if (bundles.length === 0 && Object.keys(counts).length === 0) continue
      sessions[sessionId] = { bundles, usage: counts, updatedAt: new Date().toISOString() }
    }
    return { version: STATE_VERSION, sessions }
  }

  function saveStateSoon() {
    if (saveTimer !== null) return saveChain
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveChain = saveChain
        .then(async () => {
          await mkdir(directory, { recursive: true })
          const file = join(directory, STATE_FILE)
          const temporary = `${file}.tmp`
          await writeFile(temporary, `${JSON.stringify(serializeState(), null, 2)}\n`, 'utf8')
          await rename(temporary, file)
        })
        .catch((error) => log('could not write state file:', error.message || String(error)))
    }, 150)
    return saveChain
  }

  function desiredFor(sessionId) {
    const key = String(sessionId)
    let ids = desired.get(key)
    if (ids === undefined) {
      ids = new Set()
      desired.set(key, ids)
    }
    return ids
  }

  /** Load counts for one session; created on demand so a first use can be recorded. */
  function usageFor(sessionId) {
    const key = String(sessionId)
    let counts = usage.get(key)
    if (counts === undefined) {
      counts = new Map()
      usage.set(key, counts)
    }
    return counts
  }

  /* ------------------------------------------------------------ catalog */

  async function loadConfig() {
    await migration.catch(() => null)
    const file = join(directory, CONFIG_FILE)
    try {
      const text = await readFile(file, 'utf8')
      const parsed = JSON.parse(text)
      const raw = Array.isArray(parsed && parsed.bundles) ? parsed.bundles.filter(usableEntry) : []
      if (raw.length > 0) {
        const stale = (parsed && parsed.version) !== CONFIG_VERSION
        const bundled = stale ? upgradeConfig(parsed && parsed.version, raw) : raw
        const updates = mergeUpdateSettings(parsed && parsed.updates)
        if (stale) {
          // Safe to rewrite: only the appended defaults are new, so nothing the user edited is
          // dropped. Failing to persist is not fatal — the upgraded list is returned either way,
          // and the next mount upgrades again.
          try {
            const document = { ...parsed, version: CONFIG_VERSION, updates, bundles: bundled }
            await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
            if (bundled.length !== raw.length) {
              log(`upgraded config to version ${CONFIG_VERSION}: +${bundled.length - raw.length} bundle`)
            }
          } catch (error) {
            log('could not persist the upgraded config:', error && error.message ? error.message : String(error))
          }
        }
        return { bundles: bundled.map(toBundleEntry), updates }
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') log('could not read config file:', error && error.message ? error.message : String(error))
    }
    try {
      await mkdir(directory, { recursive: true })
      const document = { version: CONFIG_VERSION, updates: DEFAULT_UPDATES, bundles: DEFAULT_BUNDLES }
      await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      log('wrote default config to', file)
    } catch (error) {
      log('could not write default config:', error && error.message ? error.message : String(error))
    }
    return { bundles: DEFAULT_BUNDLES, updates: { ...DEFAULT_UPDATES } }
  }

  function catalog() {
    if (catalogPromise === null) {
      catalogPromise = (async () => {
        const config = await loadConfig()
        updateSettings = config.updates
        const resolved = []
        for (const bundle of config.bundles) resolved.push(await resolveBundle(bundle))
        const index = new Map()
        for (const bundle of resolved) {
          for (const skill of bundle.skills) if (!index.has(skill.name)) index.set(skill.name, bundle.id)
        }
        nameIndex = index
        log(
          'catalog ready:',
          resolved.map((bundle) => `${bundle.id}=${bundle.skills.length}`).join(' '),
        )
        return { bundles: resolved, loadedAt: Date.now() }
      })().catch((error) => {
        catalogPromise = null
        throw error
      })
    }
    return catalogPromise
  }

  /* --------------------------------------------------------- activation */

  function liveEntry(sessionId) {
    const key = String(sessionId)
    let entry = live.get(key)
    if (entry === undefined) {
      entry = { bundles: new Set(), disposers: new Map(), failures: new Map() }
      live.set(key, entry)
    }
    return entry
  }

  /**
   * The skill registry shell bound to this agent, i.e. the one whose layer is the agent.
   * Property access (`agent.ctx.skills`) is guarded by Cordis's inject check, and the agent
   * context does not declare `skills`, so the registry is reached through the context store.
   * Whether that really files into the agent layer is not assumed: `inspect()` proves it by
   * diffing the scoped catalog against the global one.
   */
  function skillsOf(agent) {
    const scope = agent && agent.ctx
    if (scope === undefined || scope === null) return undefined
    if (typeof scope.get !== 'function') return undefined
    try {
      const service = scope.get('skills')
      return service === undefined || service === null ? undefined : service
    } catch (error) {
      log('agent context cannot resolve the skills registry:', error && error.message ? error.message : String(error))
      return undefined
    }
  }

  /** Register one bundle into the agent's layer. Returns the failures, empty when it worked. */
  function activate(agent, bundle, entry) {
    const skills = skillsOf(agent)
    if (skills === undefined) return ['the agent has no reachable skills registry']
    const registered = []
    const errors = []
    for (const skill of bundle.skills) {
      try {
        const disposer = skills.register({
          name: skill.name,
          description: skill.description,
          content: skill.content,
          source: SOURCE,
          provider: PROVIDER,
          invocation: { modelInvocable: true, userInvocable: false },
          resourceBase: { kind: 'directory', path: skill.directory },
          metadata: { bundle: bundle.id, file: skill.file },
        })
        if (typeof disposer !== 'function') {
          errors.push(`${skill.name}: register() did not return a disposer`)
          continue
        }
        registered.push(disposer)
      } catch (error) {
        errors.push(`${skill.name}: ${error && error.message ? error.message : String(error)}`)
      }
    }
    if (registered.length === 0) {
      for (const message of errors) log(`could not register in ${bundle.id}:`, message)
      return errors.length > 0 ? errors : [`no skills in ${bundle.id}`]
    }
    entry.disposers.set(bundle.id, registered)
    entry.bundles.add(bundle.id)
    log(`activated ${bundle.id} (${registered.length}/${bundle.skills.length} skills) for ${String(agent.id)}`)
    return errors
  }

  function deactivate(bundleId, entry) {
    const registered = entry.disposers.get(bundleId)
    entry.disposers.delete(bundleId)
    entry.bundles.delete(bundleId)
    entry.failures.delete(bundleId)
    if (registered === undefined) return
    for (const dispose of registered) {
      try {
        dispose()
      } catch (error) {
        log(`could not dispose ${bundleId}:`, error && error.message ? error.message : String(error))
      }
    }
    log(`deactivated ${bundleId}`)
  }

  /**
   * Make the agent's registrations match the persisted intent. Idempotent, so it doubles as
   * the repair path after a host restart or a session resume.
   */
  async function syncAgent(agent) {
    const sessionId = String(agent.id)
    await loadState()
    const wanted = desiredFor(sessionId)
    const entry = liveEntry(sessionId)
    const resolved = await catalog()
    for (const bundleId of [...entry.bundles]) {
      if (!wanted.has(bundleId)) deactivate(bundleId, entry)
    }
    for (const bundleId of wanted) {
      if (entry.bundles.has(bundleId)) continue
      const bundle = resolved.bundles.find((candidate) => candidate.id === bundleId)
      if (bundle === undefined || bundle.skills.length === 0) continue
      const failures = activate(agent, bundle, entry)
      if (entry.bundles.has(bundleId)) entry.failures.delete(bundleId)
      else entry.failures.set(bundleId, failures)
    }
    return entry
  }

  /* ------------------------------------------------------------ updates */

  /**
   * A record is the description of the clone plus how it was obtained. `fetched` says whether
   * the remote-tracking refs were refreshed in this check, which is the difference between
   * "0 behind" and "0 behind as of the last fetch" — only the first one means up to date.
   */
  function stampRecord(bundle, described, extra) {
    return {
      id: bundle.id,
      root: bundle.root,
      local: bundle.local === true,
      git: described.git,
      branch: described.branch,
      upstream: described.upstream,
      remoteUrl: described.remoteUrl,
      head: described.head,
      upstreamHead: described.upstreamHead,
      behind: described.behind,
      ahead: described.ahead,
      dirty: described.dirty,
      dirtyFiles: described.dirtyFiles,
      fetched: extra.fetched,
      checkedAt: extra.checkedAt,
      error: extra.error === undefined ? null : extra.error,
    }
  }

  async function loadUpdates() {
    if (updatesLoaded) return
    updatesLoaded = true
    await migration.catch(() => null)
    try {
      const text = await readFile(join(directory, UPDATES_FILE), 'utf8')
      const parsed = JSON.parse(text)
      updatesCheckedAt = typeof parsed.checkedAt === 'string' ? parsed.checkedAt : null
      const bundles = parsed && parsed.bundles && typeof parsed.bundles === 'object' ? parsed.bundles : {}
      for (const [id, record] of Object.entries(bundles)) {
        if (record !== null && typeof record === 'object') updates.set(id, record)
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') log('could not read update cache:', error && error.message ? error.message : String(error))
    }
  }

  async function saveUpdates() {
    try {
      await mkdir(directory, { recursive: true })
      const file = join(directory, UPDATES_FILE)
      const temporary = `${file}.tmp`
      const document = { version: UPDATES_VERSION, checkedAt: updatesCheckedAt, bundles: Object.fromEntries(updates) }
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      await rename(temporary, file)
    } catch (error) {
      log('could not write update cache:', error && error.message ? error.message : String(error))
    }
  }

  /**
   * git writes FETCH_HEAD and touches the index, so two overlapping calls in the same clone can
   * interleave — a background check racing a pull makes `pull` fail with "Cannot fast-forward to
   * multiple branches". Every fetch and pull therefore goes through this queue; the read-only
   * describe calls stay direct so they never wait behind the network.
   */
  let gitQueue = Promise.resolve()
  function serializeGit(task) {
    const next = gitQueue.then(task, task)
    gitQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  const gitFetch = (root, timeout) => serializeGit(() => fetchRepository(root, { timeout }))
  const gitPull = (root, timeout) => serializeGit(() => pullRepository(root, { timeout }))

  async function checkBundle(bundle, options) {
    const timeout = options.timeout
    const network = options.network === true
    // A package-local bundle has no history to be behind, so there is nothing to fetch and the
    // record says so with no error attached — an error would read as a broken checkout.
    if (bundle.local === true) {
      return stampRecord(bundle, EMPTY_DESCRIPTION, {
        fetched: false,
        checkedAt: new Date().toISOString(),
        error: null,
      })
    }
    let described = await describeRepository(bundle.root)
    let fetched = false
    let error = null
    if (!described.git) {
      return stampRecord(bundle, described, {
        fetched: false,
        checkedAt: new Date().toISOString(),
        error: 'not a git checkout, so there is nothing to fetch from',
      })
    }
    if (network) {
      const result = await gitFetch(bundle.root, timeout)
      if (result.ok) {
        fetched = true
        described = await describeRepository(bundle.root)
      } else {
        error = gitError(result)
      }
    }
    return stampRecord(bundle, described, { fetched, checkedAt: new Date().toISOString(), error })
  }

  /** Ask every bundle whether it is behind. `network: false` answers from the last fetch. */
  async function checkAll(options = {}) {
    await loadState()
    const resolved = await catalog()
    const timeout = options.timeout === undefined ? updateSettings.timeoutSeconds * 1000 : options.timeout
    const records = []
    for (const bundle of resolved.bundles) {
      let record
      try {
        record = await checkBundle(bundle, { network: options.network === true, timeout })
      } catch (failure) {
        record = {
          id: bundle.id,
          root: bundle.root,
          local: bundle.local === true,
          git: isGitCheckout(bundle.root),
          branch: null,
          upstream: null,
          remoteUrl: null,
          head: null,
          upstreamHead: null,
          behind: null,
          ahead: null,
          dirty: false,
          dirtyFiles: 0,
          fetched: false,
          checkedAt: new Date().toISOString(),
          error: failure && failure.message ? failure.message : String(failure),
        }
      }
      updates.set(bundle.id, record)
      records.push(record)
    }
    updatesCheckedAt = new Date().toISOString()
    await saveUpdates()
    return records
  }

  /**
   * Replace every live registration with freshly read documents. A pull changes the files on
   * disk, but the agent holds the *bodies* we handed it at activation time, so without this the
   * new text would only appear after a restart.
   */
  async function refreshRegistrations() {
    for (const entry of live.values()) {
      for (const bundleId of [...entry.bundles]) deactivate(bundleId, entry)
      entry.bundles.clear()
      entry.disposers.clear()
      entry.failures.clear()
    }
    for (const [sessionId] of [...live]) {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) continue
      try {
        await syncAgent(agent)
      } catch (error) {
        log('could not re-register after an update:', error && error.message ? error.message : String(error))
      }
    }
  }

  /** Fast-forward one or all bundles, then make the new text live. Never throws per bundle. */
  async function pullBundles(bundleIds) {
    await loadState()
    const resolved = await catalog()
    const wanted =
      bundleIds.length === 0
        ? resolved.bundles
        : resolved.bundles.filter((bundle) => bundleIds.includes(bundle.id))
    if (wanted.length === 0) throw new HttpError(404, `unknown bundle: ${bundleIds.join(', ')}`)
    const timeout = updateSettings.timeoutSeconds * 1000
    const results = []
    for (const bundle of wanted) {
      if (bundle.local === true) {
        results.push({
          id: bundle.id,
          ok: false,
          error: 'authored in this package, so there is no upstream to pull from',
          before: null,
          after: null,
          behind: null,
        })
        continue
      }
      const before = await describeRepository(bundle.root)
      if (!before.git) {
        results.push({ id: bundle.id, ok: false, error: 'not a git checkout', before: null, after: null, behind: null })
        continue
      }
      if (before.upstream === null) {
        results.push({ id: bundle.id, ok: false, error: `branch ${before.branch || '(detached)'} tracks no upstream`, before: null, after: null, behind: null })
        continue
      }
      const pulled = await gitPull(bundle.root, timeout)
      const after = await describeRepository(bundle.root)
      const record = stampRecord(bundle, after, { fetched: true, checkedAt: new Date().toISOString(), error: pulled.ok ? null : gitError(pulled) })
      updates.set(bundle.id, record)
      results.push({
        id: bundle.id,
        ok: pulled.ok,
        error: pulled.ok ? null : gitError(pulled),
        before: before.head === null ? null : before.head.short,
        after: after.head === null ? null : after.head.short,
        behind: after.behind,
      })
    }
    updatesCheckedAt = new Date().toISOString()
    await saveUpdates()
    if (results.some((result) => result.ok)) {
      catalogPromise = null
      await refreshRegistrations()
    }
    return results
  }

  /** Background check on mount (and before a GUI read that finds the cache stale). */
  let autoCheckTimer = null
  let autoCheckRunning = null

  async function autoCheckNow() {
    if (autoCheckRunning !== null) return autoCheckRunning
    autoCheckRunning = (async () => {
      try {
        const records = await checkAll({ network: true })
        const behind = records.filter((record) => typeof record.behind === 'number' && record.behind > 0)
        if (behind.length === 0) return
        if (!updateSettings.autoPull) {
          log('updates available:', behind.map((record) => `${record.id}+${record.behind}`).join(' '))
          return
        }
        log('auto-updating:', behind.map((record) => record.id).join(' '))
        await pullBundles(behind.map((record) => record.id))
      } catch (error) {
        log('update check failed:', error && error.message ? error.message : String(error))
      } finally {
        autoCheckRunning = null
      }
    })()
    return autoCheckRunning
  }

  function updatesAreStale() {
    if (updatesCheckedAt === null) return true
    const checked = Date.parse(updatesCheckedAt)
    if (!Number.isFinite(checked)) return true
    return Date.now() - checked > updateSettings.intervalHours * 3600 * 1000
  }

  function scheduleAutoCheck() {
    if (!updateSettings.autoCheck) return
    autoCheckTimer = setTimeout(() => {
      autoCheckTimer = null
      // The setting can change between scheduling and firing (config is read asynchronously),
      // so the guard is repeated here rather than trusted from the caller.
      if (!updateSettings.autoCheck) return
      void autoCheckNow()
    }, 2500)
    if (typeof autoCheckTimer.unref === 'function') autoCheckTimer.unref()
  }

  /** What /updates and the chips show: the cache, plus whether it is worth a new fetch. */
  async function updatesPayload() {
    await loadUpdates()
    const resolved = await catalog()
    return {
      checkedAt: updatesCheckedAt,
      stale: updatesAreStale(),
      settings: updateSettings,
      bundles: resolved.bundles.map((bundle) => updates.get(bundle.id) || null),
    }
  }

  /* ---------------------------------------------------------- inspection */

  async function cwdOf(agent) {
    try {
      return await ctx.workingDirectory.ensure(agent)
    } catch {
      return undefined
    }
  }

  /**
   * The empirical answer to "is this really per chat?".
   * The plugin context is unscoped, so `ctx.skills.list({ cwd })` is the global view; the
   * agent-scoped list must contain our skills while the global one must not.
   */
  async function inspect(agent, entry) {
    const cwd = await cwdOf(agent)
    let mine = []
    let global = []
    try {
      mine = await ctx.skills.list({ scope: agent, cwd })
    } catch (error) {
      return { error: `agent-scoped list failed: ${error && error.message ? error.message : String(error)}` }
    }
    try {
      global = await ctx.skills.list({ cwd })
    } catch (error) {
      return { error: `global list failed: ${error && error.message ? error.message : String(error)}` }
    }
    const mineNames = new Set(mine.map((skill) => skill.name))
    const globalNames = new Set(global.map((skill) => skill.name))
    const activeBundles = [...entry.bundles]
    const resolved = await catalog()
    const ours = []
    for (const bundleId of activeBundles) {
      const bundle = resolved.bundles.find((candidate) => candidate.id === bundleId)
      if (bundle === undefined) continue
      for (const skill of bundle.skills) ours.push(skill.name)
    }
    const visibleOnlyHere = ours.filter((skillName) => mineNames.has(skillName) && !globalNames.has(skillName))
    const leakedGlobal = ours.filter((skillName) => globalNames.has(skillName))
    const missingHere = ours.filter((skillName) => !mineNames.has(skillName))
    return {
      activeBundles,
      visibleOnlyHere,
      leakedGlobal,
      missingHere,
      scopedCatalogSize: mineNames.size,
      globalCatalogSize: globalNames.size,
      verdict: ours.length === 0 ? 'nothing-registered' : leakedGlobal.length > 0 ? 'leaked-global' : visibleOnlyHere.length === ours.length ? 'per-session' : 'partial',
    }
  }

  /* ------------------------------------------------------------- state */

  async function stateFor(sessionId) {
    const resolved = await catalog()
    await loadUpdates()
    const key = sessionId === undefined || sessionId === null || String(sessionId) === '' ? '' : String(sessionId)
    const agent = key === '' ? undefined : ctx.agents.get(key)
    const entry = agent !== undefined ? await syncAgent(agent) : undefined
    const enabled = entry !== undefined ? entry.bundles : new Set(desiredFor(key))
    const counts = usage.get(key) || new Map()
    const proof = agent !== undefined && entry !== undefined ? await inspect(agent, entry) : undefined
    return {
      sessionId: key === '' ? null : key,
      live: agent !== undefined,
      bundles: resolved.bundles.map((bundle) => {
        const used = {}
        let total = 0
        for (const skill of bundle.skills) {
          const count = counts.get(skill.name) || 0
          if (count > 0) {
            used[skill.name] = count
            total += count
          }
        }
        return {
          id: bundle.id,
          label: bundle.label,
          title: bundle.title,
          blurb: bundle.blurb,
          root: bundle.root,
          present: bundle.present,
          enabled: enabled.has(bundle.id),
          skills: bundle.skills.map((skill) => skill.name),
          used,
          uses: total,
          update: updates.get(bundle.id) || null,
          updateText: describeUpdate(updates.get(bundle.id) || null),
          error: bundle.error ?? null,
          warnings: bundle.warnings ?? [],
        }
      }),
      // `null`, not `undefined`: tool output must survive a lossless JSON round trip, and an
      // absent key is exactly the kind of value that check rejects.
      proof: proof ?? null,
    }
  }

  async function toggle(sessionId, bundleId, enabled) {
    const key = String(sessionId || '')
    if (key === '') throw new HttpError(400, 'sessionId is required')
    const resolved = await catalog()
    const bundle = resolved.bundles.find((candidate) => candidate.id === bundleId)
    if (bundle === undefined) throw new HttpError(404, `unknown bundle: ${bundleId}`)
    await loadState()
    const wanted = desiredFor(key)
    if (enabled) {
      if (!bundle.present || bundle.skills.length === 0) {
        throw new HttpError(409, bundle.error || `bundle ${bundleId} has no skills to register`)
      }
      wanted.add(bundleId)
    } else {
      wanted.delete(bundleId)
    }
    await saveStateSoon()
    const agent = ctx.agents.get(key)
    if (agent !== undefined) {
      const entry = await syncAgent(agent)
      if (enabled && !entry.bundles.has(bundleId)) {
        const failures = entry.failures.get(bundleId) || []
        throw new HttpError(409, failures[0] || `could not register bundle ${bundleId}`)
      }
    }
    return stateFor(key)
  }

  /* ---------------------------------------------------------------- HTTP */

  function sendJson(response, status, payload) {
    const text = JSON.stringify(payload)
    response.statusCode = status
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.end(text)
  }

  function sendError(response, status, message) {
    sendJson(response, status, { ok: false, error: { code: status >= 500 ? 'internal' : 'request', message } })
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new HttpError(413, 'request body is too large'))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (text === '') return resolve({})
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new HttpError(400, 'request body is not valid JSON'))
        }
      })
      request.on('error', reject)
    })
  }

  const handler = async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      const suffix = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) : url.pathname
      const method = (request.method || 'GET').toUpperCase()

      if (suffix === '' || suffix === '/' || suffix === '/health') {
        const resolved = await catalog()
        sendJson(response, 200, {
          ok: true,
          value: {
            plugin: name,
            directory,
            bundles: resolved.bundles.map((bundle) => ({
              id: bundle.id,
              label: bundle.label,
              root: bundle.root,
              present: bundle.present,
              skills: bundle.skills.map((skill) => skill.name),
              error: bundle.error ?? null,
            })),
          },
        })
        return
      }

      if (suffix === '/state') {
        if (method !== 'GET') return sendError(response, 405, 'method not allowed')
        const sessionId = url.searchParams.get('sessionId') || ''
        sendJson(response, 200, { ok: true, value: await stateFor(sessionId) })
        return
      }

      if (suffix === '/toggle') {
        if (method !== 'POST') return sendError(response, 405, 'method not allowed')
        const body = await readBody(request)
        if (body === null || typeof body !== 'object') return sendError(response, 400, 'body must be a JSON object')
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const bundleId = typeof body.bundleId === 'string' ? body.bundleId : ''
        const enabled = body.enabled === true
        sendJson(response, 200, { ok: true, value: await toggle(sessionId, bundleId, enabled) })
        return
      }

      if (suffix === '/refresh') {
        if (method !== 'POST' && method !== 'GET') return sendError(response, 405, 'method not allowed')
        catalogPromise = null
        const resolved = await catalog()
        sendJson(response, 200, {
          ok: true,
          value: resolved.bundles.map((bundle) => ({ id: bundle.id, skills: bundle.skills.map((skill) => skill.name), error: bundle.error })),
        })
        return
      }

      if (suffix === '/updates') {
        if (method !== 'GET') return sendError(response, 405, 'method not allowed')
        const value = await updatesPayload()
        // A cached read stays fast; a stale cache triggers one background fetch instead.
        if (value.stale && value.settings.autoCheck) void autoCheckNow()
        sendJson(response, 200, { ok: true, value })
        return
      }

      if (suffix === '/updates/check') {
        if (method !== 'POST' && method !== 'GET') return sendError(response, 405, 'method not allowed')
        const records = await checkAll({ network: true })
        sendJson(response, 200, { ok: true, value: { checkedAt: updatesCheckedAt, bundles: records } })
        return
      }

      if (suffix === '/updates/pull') {
        if (method !== 'POST') return sendError(response, 405, 'method not allowed')
        const body = await readBody(request)
        if (body === null || typeof body !== 'object') return sendError(response, 400, 'body must be a JSON object')
        const requested = typeof body.bundle === 'string' && body.bundle !== '' ? [body.bundle] : []
        const results = await pullBundles(requested)
        const payload = await updatesPayload()
        sendJson(response, 200, { ok: true, value: { results, bundles: payload.bundles, checkedAt: payload.checkedAt } })
        return
      }

      sendError(response, 404, `unknown endpoint: ${suffix}`)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      const message = error && error.message ? error.message : String(error)
      if (status >= 500) log('request failed:', message)
      sendError(response, status, message)
    }
  }

  disposers.push(ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }))

  /* ---------------------------------------------------------------- tool */

  const bundleIds = DEFAULT_BUNDLES.map((bundle) => bundle.id)

  function renderState(value) {
    const lines = []
    if (value.live === false) lines.push(`Session ${value.sessionId || '(none)'} has no live agent; toggles are stored but cannot be applied.`)
    for (const bundle of value.bundles) {
      const status = bundle.enabled ? 'ON ' : 'off'
      const detail =
        bundle.skills.length > 0
          ? `${bundle.skills.length} skill${bundle.skills.length === 1 ? '' : 's'}: ${bundle.skills.join(', ')}`
          : bundle.error || 'no skills discovered'
      const runs = bundle.uses > 0 ? ` · body loaded ${bundle.uses}\u00d7` : ' · never loaded'
      lines.push(`${status}  ${bundle.label} (${bundle.id}) — ${detail}${runs}`)
      lines.push(`      source: ${describeUpdate(bundle.update)}`)
    }
    if (value.proof !== undefined && value.proof !== null) {
      if (typeof value.proof === 'string') lines.push(`scope check: ${value.proof}`)
      else if (value.proof.error !== undefined) lines.push(`scope check failed: ${value.proof.error}`)
      else {
        lines.push(
          `scope check: verdict=${value.proof.verdict}; visible only in this session=[${value.proof.visibleOnlyHere.join(', ')}]; ` +
            `also visible globally (leak)=[${value.proof.leakedGlobal.join(', ')}]; scoped catalog=${value.proof.scopedCatalogSize}, global catalog=${value.proof.globalCatalogSize}`,
        )
      }
    }
    return lines.join('\n')
  }

  try {
    disposers.push(
      ctx.tools.register({
        name: 'skill_rail',
        description:
          `Inspect or change the skill bundles attached to this chat. Bundles are groups of loadable skills (${bundleIds.join(', ')}); enabling one adds its skills to this session\u2019s available-skills catalog so the \`skill\` tool can load them, disabling removes them. \`status\` also reports whether those skills are visible in this session only or leaked into the global catalog, and where each bundle\u2019s source lives. \`updates\` fetches the git sources and reports whether they are behind (a bundle authored inside the package is reported, not fetched); \`update\` fast-forwards one bundle (or all) and re-registers the new text immediately.`,
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'enable', 'disable', 'updates', 'update'],
              description:
                'status reads the rail; enable/disable flips one bundle for this chat only; updates fetches the sources and reports whether they are behind; update fast-forwards one bundle (or all when bundle is omitted).',
            },
            bundle: {
              type: 'string',
              enum: bundleIds,
              description: 'Bundle id. Required for enable/disable; optional for update (omit to update all).',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: renderState(value) }],
        },
        execute: async (args, exec) => {
          const input = args && typeof args === 'object' ? args : {}
          const action = typeof input.action === 'string' ? input.action : 'status'
          const sessionId = exec && exec.agent ? String(exec.agent.id) : ''
          if (sessionId === '') throw new Error('skill_rail needs a live agent')
          if (action === 'status') return stateFor(sessionId)
          const bundleId = typeof input.bundle === 'string' ? input.bundle : ''
          if (action === 'updates') {
            await checkAll({ network: true })
            return stateFor(sessionId)
          }
          if (action === 'update') {
            const results = await pullBundles(bundleId === '' ? [] : [bundleId])
            const failed = results.filter((result) => !result.ok)
            if (failed.length === results.length && results.length > 0) {
              throw new Error(`could not update: ${failed.map((result) => `${result.id}: ${result.error}`).join('; ')}`)
            }
            return stateFor(sessionId)
          }
          if (bundleId === '') throw new Error('bundle is required for enable/disable')
          return toggle(sessionId, bundleId, action === 'enable')
        },
      }),
    )
  } catch (error) {
    log('could not register the skill_rail tool:', error && error.message ? error.message : String(error))
  }

  /* ------------------------------------------------------------ lifecycle */

  /* ------------------------------------------------------- evidence of use */

  /**
   * Count real `skill` tool loads. A model that only *sees* a skill in the catalog has not
   * used it; this counts the moment it pulls the body, which is the only unambiguous proof.
   * The listener is synchronous on purpose — `tools/result` is an emit feed and must not
   * delay the turn.
   */
  function skillNameOf(args) {
    if (typeof args === 'string') {
      try {
        const parsed = JSON.parse(args)
        return parsed && typeof parsed === 'object' && typeof parsed.name === 'string' ? parsed.name : ''
      } catch {
        return ''
      }
    }
    if (args !== null && typeof args === 'object' && typeof args.name === 'string') return args.name
    return ''
  }

  ctx.on('tools/result', (exec) => {
    try {
      if (exec === null || typeof exec !== 'object') return
      if (typeof exec.name !== 'string' || exec.name.toLowerCase() !== 'skill') return
      const sessionId = exec.agent && exec.agent.id !== undefined ? String(exec.agent.id) : ''
      if (sessionId === '') return
      const skillName = skillNameOf(exec.arguments)
      if (skillName === '') return
      const bundleId = nameIndex.get(skillName)
      if (bundleId === undefined) return
      if (!desiredFor(sessionId).has(bundleId)) return
      const counts = usageFor(sessionId)
      counts.set(skillName, (counts.get(skillName) || 0) + 1)
      void saveStateSoon()
      log(`skill body loaded: ${skillName} (${bundleId}) in session ${sessionId}`)
    } catch (error) {
      log('usage counter failed:', error && error.message ? error.message : String(error))
    }
  })

  // A live agent appearing (new chat, or a resumed chat after a restart) gets its saved
  // bundles back. Errors stay in the log instead of failing the agent's own startup.
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await syncAgent(agent)
    } catch (error) {
      log('could not restore bundles:', error && error.message ? error.message : String(error))
    }
  })

  ctx.effect(
    () => () => {
      if (saveTimer !== null) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      if (autoCheckTimer !== null) {
        clearTimeout(autoCheckTimer)
        autoCheckTimer = null
      }
      for (const entry of live.values()) {
        for (const bundleId of [...entry.bundles]) deactivate(bundleId, entry)
      }
      live.clear()
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch (error) {
          log('dispose failed:', error && error.message ? error.message : String(error))
        }
      }
    },
    'dsh-mastery: routes, tool and registrations',
  )

  // State, config and the update cache are read once; the auto-check is scheduled only after
  // `catalog()` has folded config.json into `updateSettings`, otherwise it would decide against
  // the built-in defaults instead of the user's file.
  void Promise.allSettled([loadState(), catalog(), loadUpdates()]).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') log('mount read failed:', result.reason && result.reason.message ? result.reason.message : String(result.reason))
    }
    scheduleAutoCheck()
  })
  log(`mounted; data directory ${directory}`)
}

export {
  CONFIG_VERSION,
  DEFAULT_BUNDLES,
  DEFAULT_UPDATES,
  describeUpdate,
  findSkillFiles,
  mergeUpdateSettings,
  parseFrontmatter,
  parseSkillDocument,
  upgradeConfig,
}
