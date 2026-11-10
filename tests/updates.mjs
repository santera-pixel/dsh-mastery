// Unit tests for the update machinery: the two pure formatters in index.js and the git
// wrapper in lib/git.js, exercised against a throwaway repository. No harness, no network.
//   node tests/updates.mjs

import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describeUpdate, mergeUpdateSettings } from '../index.js'
import { DEFAULT_TIMEOUT_MS, describeRepository, fetchRepository, gitError, isGitCheckout, pullRepository, runGit } from '../lib/git.js'

const run = promisify(execFile)
let failures = 0

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function equal(label, actual, expected) {
  check(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

const head = { sha: 'a'.repeat(40), short: 'abc1234', date: '2026-11-10T12:00:00+02:00', subject: 'x' }

console.log('describeUpdate')
{
  equal('unchecked', describeUpdate(null), 'source not checked yet')
  equal('not a checkout', describeUpdate({ git: false, root: '/srv/skills' }), 'not a git checkout (/srv/skills)')
  equal(
    'behind, plural',
    describeUpdate({ git: true, upstream: 'origin/main', behind: 3, ahead: 0, head, dirty: false, fetched: true }),
    '3 commits behind origin/main @ abc1234 (2026-11-10)',
  )
  equal(
    'behind, singular',
    describeUpdate({ git: true, upstream: 'origin/main', behind: 1, ahead: 0, head: null, dirty: false, fetched: true }),
    '1 commit behind origin/main',
  )
  equal(
    'ahead only',
    describeUpdate({ git: true, upstream: 'origin/main', behind: 0, ahead: 2, head: null, dirty: false, fetched: true }),
    'even with origin/main (2 local commits not pushed)',
  )
  equal(
    'up to date',
    describeUpdate({ git: true, upstream: 'origin/main', behind: 0, ahead: 0, head: null, dirty: false, fetched: true }),
    'up to date with origin/main',
  )
  equal(
    'falls back to the remote url',
    describeUpdate({ git: true, upstream: null, remoteUrl: 'https://example.invalid/r.git', behind: 0, ahead: 0, head: null, dirty: false, fetched: true }),
    'up to date with https://example.invalid/r.git',
  )
  equal(
    'no upstream at all',
    describeUpdate({ git: true, upstream: null, remoteUrl: null, behind: 0, ahead: 0, head: null, dirty: false, fetched: true }),
    'up to date with no upstream',
  )
  equal(
    'error wins over distance',
    describeUpdate({ git: true, upstream: 'origin/main', behind: 4, error: 'boom', head: null, dirty: false, fetched: true }),
    'check failed: boom',
  )
  equal(
    'unknown distance',
    describeUpdate({ git: true, upstream: 'origin/main', behind: null, head: null, dirty: false, fetched: true }),
    'status unknown',
  )
  equal(
    'dirty tree, cached fetch',
    describeUpdate({ git: true, upstream: 'origin/main', behind: 2, ahead: 0, head, dirty: true, dirtyFiles: 2, fetched: false }),
    '2 commits behind origin/main @ abc1234 (2026-11-10), 2 edited files locally — from the last fetch, not a fresh check',
  )
  equal(
    'one edited file',
    describeUpdate({ git: true, upstream: 'origin/main', behind: 0, ahead: 0, head: null, dirty: true, dirtyFiles: 1, fetched: true }),
    'up to date with origin/main, 1 edited file locally',
  )
}

console.log('mergeUpdateSettings')
{
  equal('defaults', JSON.stringify(mergeUpdateSettings(undefined)), JSON.stringify({ autoCheck: true, autoPull: false, intervalHours: 6, timeoutSeconds: 60 }))
  equal('junk input', JSON.stringify(mergeUpdateSettings('nope')), JSON.stringify({ autoCheck: true, autoPull: false, intervalHours: 6, timeoutSeconds: 60 }))
  equal(
    'explicit values',
    JSON.stringify(mergeUpdateSettings({ autoCheck: false, autoPull: true, intervalHours: 12, timeoutSeconds: 120 })),
    JSON.stringify({ autoCheck: false, autoPull: true, intervalHours: 12, timeoutSeconds: 120 }),
  )
  equal(
    'rejects bad numbers and wrong types',
    JSON.stringify(mergeUpdateSettings({ autoCheck: 'yes', intervalHours: -1, timeoutSeconds: 2 })),
    JSON.stringify({ autoCheck: true, autoPull: false, intervalHours: 6, timeoutSeconds: 60 }),
  )
}

console.log('lib/git.js')
{
  equal('default timeout', DEFAULT_TIMEOUT_MS, 60_000)
  equal('timed out error', gitError({ timedOut: true, stderr: '', stdout: '', code: 1 }), 'git timed out')
  equal(
    'last stderr line',
    gitError({ timedOut: false, stderr: 'warning: one\nfatal: no upstream configured\n', stdout: '', code: 128 }),
    'fatal: no upstream configured',
  )
  equal('no output', gitError({ timedOut: false, stderr: '', stdout: '', code: 4 }), 'git exited with 4')

  const base = await mkdtemp(join(tmpdir(), 'dsh-mastery-test-'))
  const repo = join(base, 'clone')
  await mkdir(repo, { recursive: true })
  try {
    check('plain directory is not a checkout', isGitCheckout(repo) === false)

    await run('git', ['init', '-q', '-b', 'main', repo])
    await run('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid'])
    await run('git', ['-C', repo, 'config', 'user.name', 'Test'])
    await writeFile(join(repo, 'SKILL.md'), '---\nname: alpha\ndescription: d\n---\nbody\n')
    await run('git', ['-C', repo, 'add', '.'])
    await run('git', ['-C', repo, 'commit', '-q', '-m', 'first'])
    check('a real clone is a checkout', isGitCheckout(repo) === true)

    const described = await describeRepository(repo)
    equal('git flag', described.git, true)
    equal('branch', described.branch, 'main')
    equal('no upstream', described.upstream, null)
    equal('distance unknown without upstream', described.behind, null)
    equal('clean tree', described.dirty, false)
    check('head resolved', described.head !== null && /^[0-9a-f]{40}$/.test(described.head.sha), JSON.stringify(described.head))
    check('subject captured', described.head !== null && described.head.subject === 'first', JSON.stringify(described.head))

    await writeFile(join(repo, 'SKILL.md'), '---\nname: alpha\ndescription: edited\n---\nbody\n')
    const dirty = await describeRepository(repo)
    equal('local edit detected', dirty.dirty, true)
    equal('one edited file', dirty.dirtyFiles, 1)

    const fetched = await fetchRepository(repo, { timeout: 5000 })
    equal('fetch without a remote resolves', fetched.ok, false)
    const pulled = await pullRepository(repo, { timeout: 5000 })
    equal('pull without a remote resolves', pulled.ok, false)
    check('pull reports a reason', gitError(pulled) !== '', gitError(pulled))

    const mentioned = await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    equal('runGit returns ok', mentioned.ok, true)
    equal('runGit trims', mentioned.stdout, 'main')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

console.log('lib/git.js against a local origin')
{
  const base = await mkdtemp(join(tmpdir(), 'dsh-mastery-origin-'))
  const origin = join(base, 'origin.git')
  const upstream = join(base, 'upstream')
  const clone = join(base, 'clone')
  try {
    await run('git', ['init', '--bare', '-q', '-b', 'main', origin])
    await run('git', ['clone', '-q', origin, upstream])
    await run('git', ['-C', upstream, 'config', 'user.email', 'test@example.invalid'])
    await run('git', ['-C', upstream, 'config', 'user.name', 'Test'])
    await run('git', ['-C', upstream, 'checkout', '-q', '-b', 'main'])
    await writeFile(join(upstream, 'SKILL.md'), '---\nname: alpha\ndescription: v1\n---\nbody\n')
    await run('git', ['-C', upstream, 'add', '.'])
    await run('git', ['-C', upstream, 'commit', '-q', '-m', 'v1'])
    await run('git', ['-C', upstream, 'push', '-q', '-u', 'origin', 'main'])

    await run('git', ['clone', '-q', origin, clone])
    await run('git', ['-C', clone, 'config', 'user.email', 'test@example.invalid'])
    await run('git', ['-C', clone, 'config', 'user.name', 'Test'])

    const fresh = await describeRepository(clone)
    equal('clone tracks origin/main', fresh.upstream, 'origin/main')
    equal('fresh clone is level', fresh.behind, 0)
    equal('upstream url read', fresh.remoteUrl, origin)

    await writeFile(join(upstream, 'SKILL.md'), '---\nname: alpha\ndescription: v2\n---\nbody\n')
    await run('git', ['-C', upstream, 'add', '.'])
    await run('git', ['-C', upstream, 'commit', '-q', '-m', 'v2'])
    await run('git', ['-C', upstream, 'push', '-q', 'origin', 'main'])

    const fetched = await fetchRepository(clone)
    equal('fetch succeeds', fetched.ok, true)
    const behind = await describeRepository(clone)
    equal('one commit behind after fetch', behind.behind, 1)
    equal('nothing ahead', behind.ahead, 0)
    equal(
      'description names the distance',
      describeUpdate({ ...behind, fetched: true }).startsWith(`${1} commit behind origin/main`),
      true,
    )

    const pulled = await pullRepository(clone)
    equal('fast-forward succeeds', pulled.ok, true)
    const level = await describeRepository(clone)
    equal('level after the pull', level.behind, 0)
    const upstreamHead = await runGit(upstream, ['rev-parse', 'HEAD'])
    equal('clone head moved to the new commit', level.head !== null ? level.head.sha : null, upstreamHead.stdout)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
