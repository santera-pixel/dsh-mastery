// Standalone self-check for the host half: no harness, no Cordis, no network.
//   node selfcheck.mjs
// Verifies frontmatter parsing, the config upgrade path, and that every default bundle resolves
// to the skill names its source declares.

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  CONFIG_VERSION,
  DEFAULT_BUNDLES,
  describeUpdate,
  findSkillFiles,
  parseFrontmatter,
  parseSkillDocument,
  upgradeConfig,
} from './index.js'

const NAME_RULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
let failures = 0

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

console.log('frontmatter')
{
  const plain = parseFrontmatter('name: alpha\ndescription: Beta gamma.')
  check('plain scalars', plain.name === 'alpha' && plain.description === 'Beta gamma.', JSON.stringify(plain))
  const quoted = parseFrontmatter('name: "alpha"\ndescription: \'A: b, c\'')
  check('quoted scalars', quoted.name === 'alpha' && quoted.description === 'A: b, c', JSON.stringify(quoted))
  const folded = parseFrontmatter('name: alpha\ndescription: >\n  one\n  two\n')
  check('folded block', folded.description === 'one two', JSON.stringify(folded))
  const literal = parseFrontmatter('name: alpha\ndescription: |\n  one\n  two\n')
  check('literal block', literal.description === 'one\ntwo', JSON.stringify(literal))
  const comments = parseFrontmatter('# leading\nname: alpha\ndescription: d')
  check('comments ignored', comments.name === 'alpha' && comments.description === 'd', JSON.stringify(comments))
}

console.log('document')
{
  const document = parseSkillDocument('---\nname: alpha\ndescription: d\n---\n\n# Title\n\nbody\n')
  check('name/description/body', document !== null && document.name === 'alpha' && document.description === 'd' && document.content.startsWith('# Title'), JSON.stringify(document))
  check('missing fence', parseSkillDocument('# just markdown\n') === null)
  check('missing description', parseSkillDocument('---\nname: alpha\n---\nbody\n') === null)
}

console.log('bundles')
const expected = { '3dviz': 1, antislop: 6, uiux: 7, assay: 1 }
let total = 0
let missing = 0
for (const bundle of DEFAULT_BUNDLES) {
  // The clones are somebody else's repositories; a fresh checkout or a CI runner does not have
  // them, so their absence is a skip, not a failure. A package-local bundle ships with the
  // plugin, so its absence is always a failure.
  if (!bundle.local && !existsSync(bundle.root)) {
    missing += 1
    console.log(`  skip ${bundle.id}: ${bundle.root} is not cloned`)
    continue
  }
  if (bundle.local) check(`${bundle.id}: ships inside the package`, existsSync(bundle.root), bundle.root)
  const files = await findSkillFiles(bundle.root)
  const names = []
  const warnings = []
  for (const file of files) {
    const parsed = parseSkillDocument(await readFile(file, 'utf8'))
    if (parsed === null) {
      warnings.push(`${file}: unparsable`)
      continue
    }
    if (!NAME_RULE.test(parsed.name)) {
      warnings.push(`${file}: bad name ${parsed.name}`)
      continue
    }
    if (!names.includes(parsed.name)) names.push(parsed.name)
  }
  total += names.length
  const want = expected[bundle.id]
  check(
    `${bundle.id}: ${names.length} skills (want ${want})`,
    names.length === want,
    `got ${names.join(', ')}${warnings.length > 0 ? ` | warnings: ${warnings.join('; ')}` : ''}`,
  )
  for (const name of names) console.log(`       - ${name} (${dirname(name) === '.' ? bundle.id : ''})`)
  check(`${bundle.id}: no duplicate names`, new Set(names).size === names.length)
  check(`${bundle.id}: no unparsable documents`, warnings.length === 0, warnings.join('; '))
}
check(`bundle ids are unique`, new Set(DEFAULT_BUNDLES.map((bundle) => bundle.id)).size === DEFAULT_BUNDLES.length)

console.log('config upgrade')
{
  // A config.json written before this release lists only the bundles that existed then.
  const older = DEFAULT_BUNDLES.filter((bundle) => bundle.id !== 'assay').map((bundle) => ({ id: bundle.id, root: bundle.root }))
  const bumped = upgradeConfig(1, older)
  check(`a v1 config gains the new bundles (${older.length} -> ${bumped.length})`, bumped.length === DEFAULT_BUNDLES.length, bumped.map((entry) => entry.id).join(','))
  check('the append preserves the existing order', bumped.slice(0, older.length).map((entry) => entry.id).join(',') === older.map((entry) => entry.id).join(','))
  check('an existing row is not duplicated', bumped.filter((entry) => entry.id === older[0].id).length === 1)
  check('the appended bundle keeps its local flag', bumped.find((entry) => entry.id === 'assay').local === true)
  check('a config without a version is treated as the oldest', upgradeConfig(undefined, []).length === DEFAULT_BUNDLES.length)
  const current = [{ id: 'demo', root: '/tmp/demo', label: 'Demo' }]
  check(`a v${CONFIG_VERSION} config is left alone, so a deleted bundle stays deleted`, upgradeConfig(CONFIG_VERSION, current) === current)
}

console.log('update text')
{
  check(
    'a package-local bundle says it has no upstream',
    describeUpdate({ local: true, root: '/somewhere' }) === 'authored in this package — there is no upstream to check',
    describeUpdate({ local: true, root: '/somewhere' }),
  )
  check('a bundle that was never checked still says so', describeUpdate(null) === 'source not checked yet')
}

if (missing === 0) check(`total skills = 15 (got ${total})`, total === 15)
else console.log(`  note ${missing} source(s) not cloned, so the total is not asserted`)

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
