import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'

const FILES: Record<string, string> = {
  '/scratch/brief.md': '# Task\n\nOwner: {{ owner }}\nTarget: {{target}}\nAgain: {{owner}}\n',
  '/scratch/ctor.md': 'Kind: {{constructor}}\n',
  '/scratch/escaped.md': 'Use \\{{literal}} and {{real}}\n',
  '/scratch/plain.md': 'Value: {{value}}\n',
  '/scratch/bad.md': 42 as unknown as string,
  '/scratch/named.md': 'A {{crate.name}} B {{iso-8601}}\n',
}

function world(on: On) {
  on('fs.read', ($, e) => {
    const text = FILES[e.path]
    if (text === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: text }
  })
  on('tool.describe', { tool: 'Agent' }, () => ({ description: 'Base agent description.' }))
  on('session.cwd', () => ({ value: '/test/cwd' }))
  const received: string[] = []
  on('tool.call', { tool: 'Agent' }, ($, e) => {
    received.push(e.prompt)
    return { result: 'spawned' }
  })
  return received
}

test('expands a brief with vars into the prompt', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ $brief: '/scratch/brief.md', vars: { owner: 'alice', target: 'x86' } })
  const ran = await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(ran.deny).toBeUndefined()
  expect(received).toEqual(['# Task\n\nOwner: alice\nTarget: x86\nAgain: alice\n'])
})

test('a JSON prompt that names no $brief reaches the agent verbatim', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ task: 'parse this', vars: { owner: 'x' } })
  await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(received).toEqual([prompt])
})

test('a tag with no var denies the call and names its line', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ $brief: '/scratch/brief.md', vars: { owner: 'alice' } })
  const ran = await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(ran.deny).toContain('target (line 4)')
  expect(received).toEqual([])
})

test('a tag named constructor is missing, not Object.prototype', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ $brief: '/scratch/ctor.md', vars: {} })
  const ran = await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(ran.deny).toContain('constructor')
  expect(received).toEqual([])
})

test('a non-string var denies the call and names its type', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ $brief: '/scratch/plain.md', vars: { value: { nested: 1 } } })
  const ran = await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(ran.deny).toContain('vars.value is object, expected a string')
  expect(received).toEqual([])
})

test('an array vars denies instead of passing the JSON through', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ $brief: '/scratch/brief.md', vars: ['owner'] })
  const ran = await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(ran.deny).toContain('vars must be an object of strings')
  expect(received).toEqual([])
})

test('a non-string $brief denies', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ $brief: 42 })
  const ran = await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(ran.deny).toContain('$brief must be a non-empty string')
  expect(received).toEqual([])
})

test('a missing brief denies the call', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ $brief: '/scratch/none.md' })
  const ran = await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(ran.deny).toContain('/scratch/none.md')
  expect(ran.deny).toContain('from /test/cwd')
  expect(received).toEqual([])
})

test('a backslash escapes a literal tag and leaves a real tag alone', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ $brief: '/scratch/escaped.md', vars: { real: 'x' } })
  await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(received).toEqual(['Use {{literal}} and x\n'])
})

test('vars that match no tag are ignored', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ $brief: '/scratch/brief.md', vars: { owner: 'alice', target: 'x86', extra: 'y' } })
  await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(received).toEqual(['# Task\n\nOwner: alice\nTarget: x86\nAgain: alice\n'])
})

test('a replacement is inserted literally, not expanded or treated as a pattern', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ $brief: '/scratch/plain.md', vars: { value: '$& {{other}}' } })
  await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(received).toEqual(['Value: $& {{other}}\n'])
})

test('an empty string is a value, not a missing var', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ $brief: '/scratch/plain.md', vars: { value: '' } })
  await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(received).toEqual(['Value: \n'])
})

test('tag names may contain dots and dashes', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({
    $brief: '/scratch/named.md',
    vars: { 'crate.name': 'parser', 'iso-8601': '2026-10-17' },
  })
  await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(received).toEqual(['A parser B 2026-10-17\n'])
})

test('the Agent description carries the brief usage', async ($, on) => {
  world(on)
  const described = await $.tool.describe({
    tool: 'Agent',
    description: 'Base agent description.',
    provider: { plugin: 'engine', tier: 'core' },
  })
  expect(described.description).toContain('Base agent description.')
  expect(described.description).toContain('brief-template mod')
  expect(described.description).toContain('$brief')
})

test('an unknown top-level key denies and names it', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ $brief: '/scratch/plain.md', vars: { value: 'v' }, extra: 1 })
  const ran = await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(ran.deny).toContain('unknown key "extra"')
  expect(received).toEqual([])
})

test('a vars key that is not a tag name denies', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ $brief: '/scratch/plain.md', vars: { 'crate name': 'v' } })
  const ran = await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(ran.deny).toContain('"crate name" is not a tag name')
  expect(received).toEqual([])
})

test('a failed expansion keeps its cause in the deny', async ($, on) => {
  const received = world(on)
  const prompt = JSON.stringify({ $brief: '/scratch/bad.md' })
  const ran = await $.tool.call({ tool: 'Agent', description: 'run', prompt })
  expect(ran.deny).toContain('brief expansion failed (throw:')
  expect(ran.deny).toContain('replace is not a function')
  expect(received).toEqual([])
})
