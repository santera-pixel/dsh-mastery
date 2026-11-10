// Standalone self-check for the host half: no harness, no Cordis, no network.
//   node selfcheck.mjs
// Verifies frontmatter parsing and verifies that the three default bundles resolve to the
// skill names the three source repositories declare.

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

import { DEFAULT_BUNDLES, findSkillFiles, parseFrontmatter, parseSkillDocument } from './index.js'

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
const expected = { '3dviz': 1, antislop: 6, uiux: 7 }
let total = 0
let missing = 0
for (const bundle of DEFAULT_BUNDLES) {
  // The three sources are somebody else's repositories; a fresh checkout or a CI runner does
  // not have them, so their absence is a skip, not a failure. Parsing above still runs.
  if (!existsSync(bundle.root)) {
    missing += 1
    console.log(`  skip ${bundle.id}: ${bundle.root} is not cloned`)
    continue
  }
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
if (missing === 0) check(`total skills = 14 (got ${total})`, total === 14)
else console.log(`  note ${missing} source(s) not cloned, so the total is not asserted`)

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
