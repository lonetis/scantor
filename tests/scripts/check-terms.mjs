#!/usr/bin/env node
// Terminology lint (docs/testing.md §11, part of `just lint`): user-facing text must not use the words the glossary of
// docs/architecture.md §2 forbids. It checks the text of the orchestrator's Vue components (template text and
// attribute values, string literals of the script), the user guides in docs/guide/ and README.md. Code is exempt:
// fenced code blocks and inline code spans in Markdown, comments, identifiers and environment variable names.
// Dependency-free (runs in a plain node container); exits 1 with one line per finding.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** The curated list: [pattern, the term to use instead]. */
export const FORBIDDEN_TERMS = [
  // "replica set" is MongoDB's term and stays allowed.
  [/\breplicas?\b(?! set)/i, 'worker (workers setting)'],
  [/\bconcurrency\b/i, 'workers / processes'],
  [/\bdry[ -]runs?\b/i, 'test run'],
  [/\bcampaigns?\b/i, 'scan'],
  [/\bcontrol plane\b/i, 'master'],
  [/\bhead nodes?\b/i, 'master'],
  [/\bscan templates?\b/i, 'template'],
  [/\bworker machines?\b/i, 'node'],
  [/\bscan tokens?\b/i, 'worker token'],
]

/** Removes code from Markdown: fenced blocks (keeping line numbers) and inline code spans. */
function markdownProse(text) {
  let fenced = false
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced
        return ''
      }
      if (fenced) return ''
      return line.replace(/`[^`]*`/g, '').replace(/<!--.*?-->/g, '')
    })
    .join('\n')
}

/** Keeps only user-visible text of a Vue SFC: template text and attribute values, script string literals. */
function vueText(text) {
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  let out = text
    // comments are not shown to users
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)))
  // identifiers, environment variable names and import paths are code
  out = out.replace(/\bSCANTOR_[A-Z0-9_]+\b/g, blank).replace(/\bimport\b[^\n]*/g, blank)
  return out
}

/** Every finding of one file: "path:line: term (use … instead)". */
export function checkText(path, text) {
  const prose = path.endsWith('.vue') ? vueText(text) : markdownProse(text)
  const findings = []
  prose.split('\n').forEach((line, index) => {
    // camelCase and snake_case identifiers are code, never prose
    const words = line.replace(/\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b\w+_\w+\b/g, ' ')
    for (const [pattern, instead] of FORBIDDEN_TERMS) {
      const match = pattern.exec(words)
      if (match) findings.push(`${path}:${index + 1}: "${match[0]}" (use ${instead})`)
    }
  })
  return findings
}

function walk(dir, accept) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, accept))
    else if (accept(entry.name)) out.push(path)
  }
  return out.sort()
}

export function checkTerms(repo = root) {
  const files = [
    ...walk(join(repo, 'orchestrator', 'app'), (name) => name.endsWith('.vue')),
    ...walk(join(repo, 'docs', 'guide'), (name) => name.endsWith('.md')),
    join(repo, 'README.md'),
  ]
  return files.flatMap((file) => checkText(relative(repo, file), readFileSync(file, 'utf8')))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = checkTerms()
  if (findings.length > 0) {
    console.error(`Terminology (docs/architecture.md §2): ${findings.length} forbidden term(s)`)
    for (const finding of findings) console.error(`  ${finding}`)
    process.exit(1)
  }
  console.log('Terminology: ok')
}
