// lib/git.js — the only place that shells out to git.
//
// A bundle is an ordinary clone of somebody else's repository: the plugin never copies the
// skills, it reads them from disk. That means "is there an update?" is a question about that
// clone — which branch it tracks, how far behind the upstream it is, and whether a fast-forward
// is safe. Nothing here writes to a repository except `pullRepository`.
//
// Every function resolves; none throws. A missing git, a network failure or a repository that
// is not a checkout has to be reportable in the UI, not fatal to the plugin.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** A fetch against a slow remote should give up rather than hang the check. */
export const DEFAULT_TIMEOUT_MS = 60_000

/** `git log --format` fields are joined with a unit separator so subjects with tabs survive. */
const FIELD = '\x1f'

const MAX_BUFFER = 8 * 1024 * 1024

/**
 * Run one git command in `root`.
 * `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` matter: without them a credential prompt
 * would block on a console that does not exist and the fetch would sit there until the timeout.
 */
export function runGit(root, args, options = {}) {
  const timeout = options.timeout === undefined ? DEFAULT_TIMEOUT_MS : options.timeout
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-C', root, ...args],
      {
        timeout,
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_PAGER: 'cat',
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error && error.killed)
        resolve({
          ok: error === null,
          code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
          stdout: String(stdout === undefined ? '' : stdout).replace(/\s+$/, ''),
          stderr: String(stderr === undefined ? '' : stderr).replace(/\s+$/, ''),
          timedOut,
        })
      },
    )
  })
}

/** A clone has `.git` as a directory; a linked worktree or submodule has it as a file. */
export function isGitCheckout(root) {
  try {
    return existsSync(join(root, '.git'))
  } catch {
    return false
  }
}

/** One readable line out of a failed git call, for the chip title and the tool output. */
export function gitError(result) {
  if (result.timedOut) return 'git timed out'
  const text = result.stderr !== '' ? result.stderr : result.stdout
  const first = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  if (first.length > 0) return first[first.length - 1]
  return `git exited with ${result.code}`
}

async function firstLine(root, args) {
  const result = await runGit(root, args)
  return result.ok && result.stdout !== '' ? result.stdout.split(/\r?\n/)[0].trim() : null
}

/** Parse `%H%x1f%h%x1f%cI%x1f%s` into an object, or null when the revision does not resolve. */
async function describeCommit(root, revision) {
  const result = await runGit(root, ['log', '-1', '--format=%H%x1f%h%x1f%cI%x1f%s', revision])
  if (!result.ok || result.stdout === '') return null
  const parts = result.stdout.split(FIELD)
  if (parts.length < 4) return null
  return { sha: parts[0], short: parts[1], date: parts[2], subject: parts.slice(3).join(FIELD) }
}

async function countBetween(root, range) {
  const result = await runGit(root, ['rev-list', '--count', range])
  const value = result.ok ? Number.parseInt(result.stdout, 10) : Number.NaN
  return Number.isFinite(value) ? value : null
}

/**
 * Everything about one clone that does not need the network: branch, upstream, local head,
 * upstream head as of the last fetch, distance in both directions, and whether the working
 * tree has local edits (which can block a fast-forward).
 */
export async function describeRepository(root) {
  const empty = {
    git: false,
    root,
    branch: null,
    upstream: null,
    remoteUrl: null,
    head: null,
    upstreamHead: null,
    behind: null,
    ahead: null,
    dirty: false,
    dirtyFiles: 0,
    error: null,
  }
  if (!isGitCheckout(root)) return empty

  const described = { ...empty, git: true }
  const branch = await firstLine(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  described.branch = branch === 'HEAD' ? null : branch

  const upstream = await firstLine(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  described.upstream = upstream

  const remote = upstream !== null && upstream.includes('/') ? upstream.slice(0, upstream.indexOf('/')) : 'origin'
  described.remoteUrl = await firstLine(root, ['remote', 'get-url', remote])

  described.head = await describeCommit(root, 'HEAD')
  if (upstream !== null) {
    described.upstreamHead = await describeCommit(root, '@{u}')
    described.behind = await countBetween(root, `HEAD..@{u}`)
    described.ahead = await countBetween(root, `@{u}..HEAD`)
  }

  const status = await runGit(root, ['status', '--porcelain', '--untracked-files=no'])
  if (status.ok) {
    const lines = status.stdout === '' ? [] : status.stdout.split(/\r?\n/)
    described.dirtyFiles = lines.length
    described.dirty = lines.length > 0
  }
  return described
}

/** The remote the current branch tracks, or `origin` when it tracks nothing. */
export async function defaultRemote(root) {
  const upstream = await firstLine(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (upstream !== null && upstream.includes('/')) return upstream.slice(0, upstream.indexOf('/'))
  const remotes = await runGit(root, ['remote'])
  if (remotes.ok && remotes.stdout !== '') return remotes.stdout.split(/\r?\n/)[0].trim()
  return 'origin'
}

/** Update the remote-tracking refs only. This is the one call that touches the network. */
export async function fetchRepository(root, options = {}) {
  const remote = await defaultRemote(root)
  return runGit(root, ['fetch', '--quiet', '--prune', '--no-tags', remote], options)
}

/**
 * Fast-forward only. A bundle directory is somebody else's clone, so a merge commit or a rebase
 * would rewrite their history; refusing is the only safe answer when the branches diverged.
 */
export async function pullRepository(root, options = {}) {
  return runGit(root, ['pull', '--ff-only', '--no-rebase', '--quiet'], options)
}

export { describeCommit }
