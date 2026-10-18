import type { EngineInterface, HookFailure, Register } from 'claude-code'

// An Agent call whose `prompt` is a JSON object of this shape is expanded
// before the agent spawns: the file at `$brief` is read, every `{{name}}`
// in it is replaced by `vars[name]`, and the finished text becomes the prompt.
type BriefRequest = { brief: string; vars: Record<string, string> }

type ParsedRequest =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ok'; request: BriefRequest }

type MissingVar = { name: string; line: number }

// What the hooks share: parsing, the read, the expansion and the deny text.
type BriefEnv = Pick<EngineInterface, 'fs' | 'session' | 'plugin'>

type Resolution = { kind: 'none' } | { kind: 'deny'; deny: string } | { kind: 'text'; text: string }

const TAG = /(\\?)\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g
const TAG_NAME = /^[A-Za-z_][\w.-]*$/
const KEYS = new Set(['$brief', 'vars'])

const USAGE = `

Brief templates (brief-template mod). When several agents share most of a
brief, write it once as a markdown file with {{name}} tags, then pass this JSON
as the whole prompt:
  {"$brief": "<path>", "vars": {"name": "value", ...}}
The file is read, each {{name}} is replaced by vars.name, and the result is the
agent's prompt. Tags may be written {{ name }}; names use letters, digits, _,
. and -. A relative path resolves against the session's working directory, not
the agent's cwd. A missing file, a missing var, a non-string var, or a key
other than $brief and vars denies the call with the reason; vars that match no
tag are ignored. Write \\{{ for a literal {{. A workflow script's agent() prompt
takes the same request.

Example. The file review-brief.md:
  Review the {{crate}} crate in worktree {{worktree}}.
  Focus: {{ focus }}. Report findings as text, not a file.
The call for one reviewer:
  {"$brief": "/path/scratchpad/review-brief.md",
   "vars": {"crate": "parser", "worktree": "../parser-wt/lexer", "focus": "error recovery"}}`

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

// A prompt with no `$brief` key is somebody else's JSON and passes through.
// A prompt that names `$brief` but carries a malformed request is refused:
// passing it on would hand the agent the JSON instead of the brief.
function parseRequest(prompt: unknown): ParsedRequest {
  if (typeof prompt !== 'string') return { kind: 'none' }
  const text = prompt.trim()
  if (!text.startsWith('{')) return { kind: 'none' }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'none' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'none' }

  const record = value as Record<string, unknown>
  if (!Object.hasOwn(record, '$brief')) return { kind: 'none' }

  const unknown = Object.keys(record).filter(key => !KEYS.has(key))
  if (unknown.length > 0) {
    const names = unknown.map(key => JSON.stringify(key)).join(', ')
    return { kind: 'invalid', reason: `unknown key ${names}; a brief request takes $brief and vars` }
  }

  const brief = record.$brief
  if (typeof brief !== 'string' || brief.trim() === '') {
    return { kind: 'invalid', reason: '$brief must be a non-empty string' }
  }

  const rawVars = Object.hasOwn(record, 'vars') ? record.vars : undefined
  if (rawVars === undefined) {
    return { kind: 'ok', request: { brief: brief.trim(), vars: Object.create(null) } }
  }
  if (typeof rawVars !== 'object' || rawVars === null || Array.isArray(rawVars)) {
    return { kind: 'invalid', reason: 'vars must be an object of strings' }
  }

  const vars: Record<string, string> = Object.create(null)
  for (const [name, entry] of Object.entries(rawVars)) {
    if (!TAG_NAME.test(name)) {
      return { kind: 'invalid', reason: `vars key ${JSON.stringify(name)} is not a tag name` }
    }
    if (typeof entry !== 'string') {
      return { kind: 'invalid', reason: `vars.${name} is ${describeType(entry)}, expected a string` }
    }
    vars[name] = entry
  }
  return { kind: 'ok', request: { brief: brief.trim(), vars } }
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0
  for (let index = from; index < to; index++) {
    if (text.charCodeAt(index) === 10) count++
  }
  return count
}

function expand(template: string, vars: Record<string, string>): { text: string; missing: MissingVar[] } {
  const missing = new Map<string, number>()
  let line = 1
  let seen = 0
  const text = template.replace(TAG, (match: string, escaped: string, name: string, offset: number) => {
    // `seen` advances with each match, so the slices partition the template
    // and the whole scan stays linear rather than rescanning per tag.
    line += countNewlines(template, seen, offset)
    seen = offset
    if (escaped !== '') return match.slice(1)
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined
    if (value === undefined) {
      if (!missing.has(name)) missing.set(name, line)
      return match
    }
    return value
  })
  return { text, missing: [...missing].map(([name, line]) => ({ name, line })) }
}

async function resolveBrief($: BriefEnv, prompt: unknown): Promise<Resolution> {
  const parsed = parseRequest(prompt)
  if (parsed.kind === 'none') return { kind: 'none' }
  if (parsed.kind === 'invalid') return { kind: 'deny', deny: `${$.plugin.name}: ${parsed.reason}` }

  const { brief, vars } = parsed.request
  let template: string
  try {
    template = await $.fs.read(brief)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    let cwd: string | undefined
    try {
      cwd = await $.session.cwd()
    } catch {
      cwd = undefined
    }
    const where = cwd === undefined ? '' : ` from ${cwd}`
    return { kind: 'deny', deny: `${$.plugin.name}: cannot read brief ${brief}${where}: ${reason}` }
  }

  const { text, missing } = expand(template, vars)
  if (missing.length > 0) {
    const tags = missing.map(({ name, line }) => `${name} (line ${line})`).join(', ')
    return { kind: 'deny', deny: `${$.plugin.name}: ${brief} has tags with no value in vars: ${tags}` }
  }
  return { kind: 'text', text }
}

// A failed hook is skipped by default, which would hand the agent the JSON.
// The cause rides along so the deny is actionable.
function expansionFailed($: BriefEnv, failure: HookFailure): string {
  const cause = failure.message === undefined ? failure.kind : `${failure.kind}: ${failure.message}`
  return `${$.plugin.name}: brief expansion failed (${cause})`
}

export const register: Register = on => {
  on('tool.describe', { tool: 'Agent' }, async ($, e, next) => {
    const described = await next(e)
    return { ...described, description: described.description + USAGE }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const resolved = await resolveBrief($, e.prompt)
    if (resolved.kind === 'none') return next(e)
    if (resolved.kind === 'deny') return { deny: resolved.deny }
    return next({ ...e, prompt: resolved.text })
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: expansionFailed($, next.error) })

  // The Agent tool's call already ran the hook above and carries the expanded
  // prompt here; a workflow script's agent() call raises only this one.
  on('agent.spawn', async ($, e, next) => {
    const resolved = await resolveBrief($, e.prompt)
    if (resolved.kind === 'none') return next(e)
    if (resolved.kind === 'deny') return { deny: resolved.deny }
    return next({ ...e, prompt: resolved.text })
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: expansionFailed($, next.error) })
}
