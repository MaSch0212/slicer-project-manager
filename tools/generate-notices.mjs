// Generates THIRD-PARTY-NOTICES.md: the hand-written sections in tools/notices-static.md, then
// the Rust crates and the npm packages that actually go into the shipped artifacts, each with its
// licence text taken from the package's own files on disk.
//
//   pnpm notices
//
// Needs the cargo registry sources and node_modules present (any build or `cargo fetch` and
// `pnpm install` does that). Nothing is downloaded by this script and nothing but the output file
// is written. What counts as "shipped":
//   * Rust: normal (non-build, non-dev) dependencies, without proc-macros, of `spm-server` for
//     x86_64-unknown-linux-musl (the Docker image) and of `spm-desktop` for x86_64-pc-windows-msvc.
//   * npm: the production dependency closure of @spm/web (the bundle embedded in both).
import { execSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = (command) =>
  execSync(command, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  })

const LICENSE_FILE = /^(licen[sc]e|copying|unlicense|notice|copyright)/i
const normalise = (text) => text.replace(/\r\n/g, '\n').replace(/^﻿/, '').trim()

const MIT = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

const BSD3 = (holder) => `Copyright (c) ${holder}. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted
provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions
   and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions
   and the following disclaimer in the documentation and/or other materials provided with the
   distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse
   or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE
USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`

const synthesised = []

/** A package's licence texts; when it ships none, the SPDX standard text with its authors. */
function licenceTexts(dir, spdx, authors, label) {
  const texts = []
  for (const name of readdirSync(dir)
    .filter((n) => LICENSE_FILE.test(n))
    .sort()) {
    try {
      texts.push(normalise(readFileSync(join(dir, name), 'utf8')))
    } catch {
      // a directory
    }
  }
  if (texts.length > 0) return texts
  const holder = authors.length ? authors.join(', ').replace(/\s*<[^>]*>/g, '') : 'the authors'
  if (spdx === 'MIT') texts.push(MIT(holder))
  else if (spdx === 'BSD-3-Clause') texts.push(BSD3(holder))
  else throw new Error(`${label}: no licence file and no template for ${spdx}`)
  synthesised.push(label)
  return texts
}

// --- Rust ---------------------------------------------------------------------------------------
const meta = JSON.parse(run('cargo metadata --locked --format-version 1'))
const byKey = new Map(meta.packages.map((p) => [`${p.name} v${p.version}`, p]))
function tree(pkg, target) {
  return run(
    `cargo tree --locked -p ${pkg} --target ${target} -e normal,no-proc-macro --prefix none --format "{p}"`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/ \(.*\)$/, ''))
    .filter((key) => byKey.get(key)?.source) // workspace members have no source: they are ours
}
const server = new Set(tree('spm-server', 'x86_64-unknown-linux-musl'))
const desktop = new Set(tree('spm-desktop', 'x86_64-pc-windows-msvc'))
const rust = [...new Set([...server, ...desktop])].sort().map((key) => {
  const p = byKey.get(key)
  const label = key.replace(' v', ' ')
  return {
    label,
    name: p.name,
    version: p.version,
    spdx: p.license ?? '(see licence files)',
    where: server.has(key) && desktop.has(key) ? 'both' : server.has(key) ? 'server' : 'desktop',
    texts: licenceTexts(dirname(p.manifest_path), p.license, p.authors ?? [], label),
  }
})
const rustSynthesised = [...synthesised]

// --- npm ----------------------------------------------------------------------------------------
const npmTree = JSON.parse(run('pnpm --filter @spm/web ls --prod --depth Infinity --json'))
const npmSeen = new Map()
;(function walk(deps) {
  for (const [name, dep] of Object.entries(deps ?? {})) {
    const key = `${name}@${dep.version}`
    if (!npmSeen.has(key)) {
      npmSeen.set(key, dep.path)
      walk(dep.dependencies)
    }
  }
})(npmTree[0].dependencies)
const npm = [...npmSeen.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, dir]) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const authors =
      typeof pkg.author === 'string' ? [pkg.author] : pkg.author?.name ? [pkg.author.name] : []
    return {
      label: key,
      spdx: pkg.license ?? '(unspecified)',
      texts: licenceTexts(dir, pkg.license, authors, key),
    }
  })
const npmSynthesised = synthesised.filter((label) => !rustSynthesised.includes(label))

// --- output -------------------------------------------------------------------------------------
const count = (entries) => {
  const kinds = new Map()
  for (const entry of entries) kinds.set(entry.spdx, (kinds.get(entry.spdx) ?? 0) + 1)
  return [...kinds]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${kind} (${n})`)
    .join(', ')
}

function licenceSection(entries) {
  const groups = new Map()
  for (const entry of entries) {
    for (const text of entry.texts) {
      if (!groups.has(text)) groups.set(text, { text, users: [] })
      const { users } = groups.get(text)
      if (!users.includes(entry.label)) users.push(entry.label)
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.users[0].localeCompare(b.users[0]) || a.text.localeCompare(b.text))
    .map(
      ({ text, users }) =>
        `#### ${users.length === 1 ? users[0] : `${users[0]} and ${users.length - 1} more`}\n\n` +
        `Used by: ${users.join(', ')}\n\n~~~~text\n${text}\n~~~~\n`,
    )
    .join('\n')
}

const both = [...server].filter((key) => desktop.has(key)).length
const out = [
  readFileSync(join(root, 'tools', 'notices-static.md'), 'utf8').trimEnd(),
  '',
  `## Rust crates (${rust.length})`,
  '',
  `The normal dependencies of \`spm-server\` (Linux, musl: ${server.size} crates) and of the desktop` +
    ` app (Windows: ${desktop.size} crates), from \`Cargo.lock\`; ${both} are in both.` +
    ` Licences as declared by each crate: ${count(rust)}.` +
    (rustSynthesised.length
      ? ` These crates ship no licence file, so the standard text of their declared licence is given, with the authors from their \`Cargo.toml\`: ${rustSynthesised.join(', ')}.`
      : ''),
  '',
  '| Crate | Version | Licence | In |',
  '| --- | --- | --- | --- |',
  ...rust.map(
    (r) => `| ${r.name} | ${r.version} | ${r.spdx.replaceAll('|', '\\|')} | ${r.where} |`,
  ),
  '',
  '### Rust licence texts',
  '',
  'Where a crate offers a choice (`MIT OR Apache-2.0`), the texts of every licence file it ships are',
  'given; the recipient may choose any of them. Crates whose texts are identical share one entry.',
  '',
  licenceSection(rust),
  `## npm packages (${npm.length})`,
  '',
  'The production dependency closure of `@spm/web`, whose build output is embedded in both artifacts.' +
    ' (A bundler drops what is unused, so a package here may contribute only part of its code.)' +
    ` Licences as declared: ${count(npm)}.` +
    (npmSynthesised.length
      ? ` Without a licence file in the package: ${npmSynthesised.join(', ')} (standard text, authors from \`package.json\`).`
      : ''),
  '',
  '| Package | Licence |',
  '| --- | --- |',
  ...npm.map((n) => `| ${n.label} | ${n.spdx} |`),
  '',
  '### npm licence texts',
  '',
  licenceSection(npm),
].join('\n')

writeFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), out.replace(/[ \t]+$/gm, '') + '\n')
// The repo's formatter owns the tables' column widths; run it so `pnpm fmt:check` stays green.
run('pnpm exec oxfmt THIRD-PARTY-NOTICES.md')
console.log(
  `notices: ${rust.length} crates, ${npm.length} npm packages; synthesised: ${synthesised.join(', ') || 'none'}`,
)
