// Drives the mounted host half through its real HTTP handler with a fake Cordis context and a
// throwaway git remote — no harness, no network, no browser.
//   node tests/http.mjs

import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

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
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

/** A minimal stand-in for the harness response object. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(text) {
      this.text = text
    },
  }
}

const base = await mkdtemp(join(tmpdir(), 'dsh-mastery-http-'))
const home = join(base, 'home')
const origin = join(base, 'origin.git')
const upstream = join(base, 'upstream')
const clone = join(base, 'clone')

try {
  // ---------------------------------------------------------------- fixture
  await mkdir(join(home, 'mastery'), { recursive: true })
  await run('git', ['init', '--bare', '-q', '-b', 'main', origin])
  await run('git', ['clone', '-q', origin, upstream])
  await run('git', ['-C', upstream, 'config', 'user.email', 'test@example.invalid'])
  await run('git', ['-C', upstream, 'config', 'user.name', 'Test'])
  await run('git', ['-C', upstream, 'checkout', '-q', '-b', 'main'])
  await writeFile(join(upstream, 'SKILL.md'), '---\nname: alpha\ndescription: v1\n---\n# Alpha\n\nbody\n')
  await run('git', ['-C', upstream, 'add', '.'])
  await run('git', ['-C', upstream, 'commit', '-q', '-m', 'v1'])
  await run('git', ['-C', upstream, 'push', '-q', '-u', 'origin', 'main'])
  await run('git', ['clone', '-q', origin, clone])
  await run('git', ['-C', clone, 'config', 'user.email', 'test@example.invalid'])
  await run('git', ['-C', clone, 'config', 'user.name', 'Test'])

  await writeFile(
    join(home, 'mastery', 'config.json'),
    JSON.stringify(
      {
        version: 1,
        updates: { autoCheck: false, autoPull: false, intervalHours: 6, timeoutSeconds: 20 },
        bundles: [{ id: 'demo', label: 'Demo', title: 'Demo bundle', blurb: 'Fixture', root: clone }],
      },
      null,
      2,
    ),
  )

  // The store directory is resolved from DSH_HOME when apply() runs, so it is set before import.
  process.env.DSH_HOME = home
  const plugin = await import('../index.js')

  const routes = []
  const tools = []
  const effects = []
  const ctx = {
    webServer: {
      register(spec) {
        routes.push(spec)
        return () => {}
      },
    },
    skills: {
      list: () => [],
      register: () => {
        throw new Error('no live agent in this fixture')
      },
      get: () => undefined,
    },
    agents: { get: () => undefined },
    tools: {
      register(spec) {
        tools.push(spec)
        return () => {}
      },
    },
    workingDirectory: () => base,
    on: () => () => {},
    effect(fn) {
      effects.push(fn)
      return fn()
    },
  }

  plugin.apply(ctx)
  check('one prefix route registered', routes.length === 1 && routes[0].kind === 'prefix')
  equal('route path', routes[0].path, '/dsh-mastery')
  check('skill_rail tool registered', tools.length === 1 && tools[0].name === 'skill_rail')

  const handler = routes[0].handler

  async function call(method, path, body) {
    const request = new EventEmitter()
    request.url = path
    request.method = method
    request.destroy = () => {}
    const response = makeResponse()
    const pending = handler(request, response)
    setImmediate(() => {
      if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body)))
      request.emit('end')
    })
    await pending
    const payload = response.text === undefined ? null : JSON.parse(response.text)
    return { status: response.statusCode, payload, headers: response.headers }
  }

  // ------------------------------------------------------------------ routes
  console.log('health')
  {
    const { status, payload } = await call('GET', '/dsh-mastery/health')
    equal('status', status, 200)
    equal('plugin name', payload.value.plugin, 'dsh-mastery')
    equal('store directory', payload.value.directory, join(home, 'mastery'))
    equal('bundle id', payload.value.bundles[0].id, 'demo')
    equal('bundle discovered', payload.value.bundles[0].skills, ['alpha'])
    equal('bundle present', payload.value.bundles[0].present, true)
  }

  console.log('state')
  {
    const { status, payload } = await call('GET', '/dsh-mastery/state?sessionId=s1')
    equal('status', status, 200)
    equal('no live agent', payload.value.live, false)
    equal('off by default', payload.value.bundles[0].enabled, false)
    equal('nothing checked yet', payload.value.bundles[0].updateText, 'source not checked yet')
    equal('no cache yet', payload.value.bundles[0].update, null)
  }

  console.log('cached updates')
  {
    const { status, payload } = await call('GET', '/dsh-mastery/updates')
    equal('status', status, 200)
    equal('stale before the first check', payload.value.stale, true)
    equal('autoCheck off is honoured', payload.value.settings.autoCheck, false)
    equal('no record yet', payload.value.bundles[0], null)
  }

  console.log('check')
  {
    const { status, payload } = await call('POST', '/dsh-mastery/updates/check')
    equal('status', status, 200)
    const record = payload.value.bundles[0]
    equal('is a git checkout', record.git, true)
    equal('tracks the upstream', record.upstream, 'origin/main')
    equal('level', record.behind, 0)
    equal('fetch happened', record.fetched, true)
    check('has a head', typeof record.head.short === 'string' && record.head.short.length >= 7, JSON.stringify(record.head))

    const cached = await call('GET', '/dsh-mastery/updates')
    equal('cache is no longer stale', cached.payload.value.stale, false)
    equal('cache survived', cached.payload.value.bundles[0].behind, 0)

    const saved = JSON.parse(await readFile(join(home, 'mastery', 'updates.json'), 'utf8'))
    equal('updates.json version', saved.version, 1)
    equal('updates.json record', saved.bundles.demo.behind, 0)
  }

  console.log('toggle without a live agent')
  {
    const { status, payload } = await call('POST', '/dsh-mastery/toggle', { sessionId: 's1', bundleId: 'demo', enabled: true })
    equal('status', status, 200)
    equal('switch stored', payload.value.bundles[0].enabled, true)
    // saveStateSoon coalesces writes on a short timer, so give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const state = JSON.parse(await readFile(join(home, 'mastery', 'state.json'), 'utf8'))
    equal('state.json persisted', state.sessions.s1.bundles, ['demo'])
  }

  console.log('pull')
  {
    await writeFile(join(upstream, 'SKILL.md'), '---\nname: alpha\ndescription: v2\n---\n# Alpha\n\nbody v2\n')
    await run('git', ['-C', upstream, 'add', '.'])
    await run('git', ['-C', upstream, 'commit', '-q', '-m', 'v2'])
    await run('git', ['-C', upstream, 'push', '-q', 'origin', 'main'])

    const checked = await call('POST', '/dsh-mastery/updates/check')
    equal('behind after the new commit', checked.payload.value.bundles[0].behind, 1)

    const pulled = await call('POST', '/dsh-mastery/updates/pull', { bundle: 'demo' })
    equal('status', pulled.status, 200)
    equal('pull ok', pulled.payload.value.results[0].ok, true)
    check(
      'pull reports the commit it moved from',
      pulled.payload.value.results[0].before !== null && pulled.payload.value.results[0].before !== pulled.payload.value.results[0].after,
      JSON.stringify(pulled.payload.value.results[0]),
    )
    equal('level in the pull result', pulled.payload.value.results[0].behind, 0)
    equal('level after pull', pulled.payload.value.bundles[0].behind, 0)

    const upstreamHead = await run('git', ['-C', upstream, 'rev-parse', 'HEAD'])
    const state = await call('GET', '/dsh-mastery/state?sessionId=s1')
    equal('clone moved to the new commit', state.payload.value.bundles[0].update.head.sha, upstreamHead.stdout.trim())
    equal('text says up to date', state.payload.value.bundles[0].updateText.split(' @ ')[0], 'up to date with origin/main')
    check('new body visible to the skill', state.payload.value.bundles[0].skills.length === 1)
  }

  console.log('errors')
  {
    const notFound = await call('GET', '/dsh-mastery/nope')
    equal('unknown route', notFound.status, 404)
    equal('error envelope', notFound.payload.ok, false)
    const wrongMethod = await call('DELETE', '/dsh-mastery/state')
    equal('wrong method', wrongMethod.status, 405)
    const badBundle = await call('POST', '/dsh-mastery/updates/pull', { bundle: 'ghost' })
    equal('unknown bundle', badBundle.status, 404)
    check('unknown bundle message', badBundle.payload.error.message.startsWith('unknown bundle'), badBundle.payload.error.message)
    const badToggle = await call('POST', '/dsh-mastery/toggle', { sessionId: '', bundleId: 'demo', enabled: true })
    equal('toggle without a session', badToggle.status, 400)
  }

  // The effect is the plugin's own cleanup; running it proves the mount is disposable.
  console.log('dispose')
  {
    for (const effect of effects) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanup()
    }
    check('one effect registered', effects.length === 1)
  }
} finally {
  await rm(base, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
