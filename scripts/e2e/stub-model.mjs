/**
 * Stub model service for scripts/e2e/headless-check.mjs.
 *
 * Answers the two call shapes the compiler makes:
 *   planner  a system message is present → a numbered plan that reads a file
 *   joiner   no system message           → Finish(<token found in the scratchpad>)
 *
 * The joiner answer is extracted from the observation the engine actually fed
 * back, so a passing run proves planner → tool dispatch → observation → joiner
 * → assistant text rather than merely that the process exited zero.
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.STUB_PORT ?? 8799)
const TARGET = process.env.STUB_TARGET ?? 'secret.txt'

const plan = `Thought: read the file first.
1. read("${TARGET}")
Thought: I can answer from the content.
2. join()<END_OF_PLAN>`

const textOf = messages => messages
  .map(message => (Array.isArray(message.content)
    ? message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    : String(message.content ?? '')))
  .join('\n')

const answer = body => {
  const messages = body.messages ?? []
  if (messages.some(message => message.role === 'system')) return plan
  const found = /TOKEN-([A-Z0-9-]+)/u.exec(textOf(messages))
  return `Thought: the observation carried the token.\nAction: Finish(TOKEN-${found === null ? 'MISSING' : found[1]})`
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && (request.url === '/v1/models' || request.url === '/models')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model', owned_by: 'stub' }] }))
    return
  }
  if (request.method !== 'POST') {
    response.writeHead(404).end()
    return
  }
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* keep empty */ }
    const content = answer(body)
    console.log(`stub ${request.url} stream=${body.stream === true} -> ${JSON.stringify(content.slice(0, 60))}`)

    if (body.stream !== true) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'stub', object: 'chat.completion', model: body.model ?? 'stub',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }))
      return
    }

    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = payload => response.write(`data: ${JSON.stringify(payload)}\n\n`)
    send({ id: 'stub', object: 'chat.completion.chunk', model: body.model ?? 'stub', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
    send({ id: 'stub', object: 'chat.completion.chunk', model: body.model ?? 'stub', choices: [{ index: 0, delta: { content }, finish_reason: null }] })
    send({ id: 'stub', object: 'chat.completion.chunk', model: body.model ?? 'stub', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`stub model on http://127.0.0.1:${PORT}/v1`))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
