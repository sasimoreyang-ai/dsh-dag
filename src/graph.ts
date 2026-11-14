export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export interface DagNode {
  id: string
  tool: string
  arguments: Record<string, Json>
  dependsOn: string[]
}

interface Reference { node: string; pointer: string }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function reference(value: Record<string, unknown>): Reference | undefined {
  if (!Object.hasOwn(value, '$dagRef')) return undefined
  const ref = value.$dagRef
  if (Object.keys(value).length !== 1 || !record(ref)
    || Object.keys(ref).some(key => !['node', 'pointer'].includes(key))
    || typeof ref.node !== 'string' || typeof ref.pointer !== 'string') {
    throw new Error('A $dagRef must contain exactly { node: string, pointer: string }.')
  }
  if (ref.pointer !== '' && !ref.pointer.startsWith('/')) {
    throw new Error('A $dagRef pointer must be empty or start with /.')
  }
  if (/~(?![01])/u.test(ref.pointer)) throw new Error('Invalid JSON pointer escape.')
  return { node: ref.node, pointer: ref.pointer }
}

/** Treat references as data. Never evaluate expressions or interpolate commands. */
export function mapArguments(value: Json, resolve: (ref: Reference) => Json, depth = 0): Json {
  if (depth > 64) throw new Error('Arguments exceed 64 levels of nesting.')
  if (Array.isArray(value)) return value.map(item => mapArguments(item, resolve, depth + 1))
  if (!record(value)) return value
  const ref = reference(value)
  if (ref) return resolve(ref)
  // fromEntries preserves an own __proto__ property without invoking its setter.
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, mapArguments(item as Json, resolve, depth + 1)]))
}

/** Validate the entire graph before any tool can acquire resources or mutate state. */
export function validateGraph(input: unknown, maxNodes: number, maxInputChars: number): DagNode[] {
  if (JSON.stringify(input).length > maxInputChars) throw new Error('DAG exceeds maxInputChars.')
  if (!Array.isArray(input) || input.length < 1 || input.length > maxNodes) {
    throw new Error(`nodes must contain between 1 and ${maxNodes} nodes.`)
  }
  const nodes: DagNode[] = input.map(value => {
    if (!record(value) || Object.keys(value).some(key => !['id', 'tool', 'arguments', 'dependsOn'].includes(key))
      || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(value.id)
      || typeof value.tool !== 'string' || !value.tool || value.tool.length > 128
      || !record(value.arguments)) throw new Error('Invalid DAG node shape.')
    const dependencies = value.dependsOn ?? []
    if (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== 'string')
      || new Set(dependencies).size !== dependencies.length) throw new Error(`Invalid dependsOn for ${value.id}.`)
    return { id: value.id, tool: value.tool, arguments: value.arguments as Record<string, Json>, dependsOn: dependencies }
  })
  const byId = new Map(nodes.map(node => [node.id, node]))
  if (byId.size !== nodes.length) throw new Error('Node ids must be unique.')
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency) || dependency === node.id) throw new Error(`Invalid dependency ${dependency} on ${node.id}.`)
    }
    mapArguments(node.arguments, ref => {
      if (!node.dependsOn.includes(ref.node)) throw new Error(`${node.id} must list reference ${ref.node} in dependsOn.`)
      return null
    })
  }
  const visited = new Set<string>()
  const visiting = new Set<string>()
  function visit(node: DagNode): void {
    if (visiting.has(node.id)) throw new Error(`Dependency cycle at ${node.id}.`)
    if (visited.has(node.id)) return
    visiting.add(node.id)
    for (const dependency of node.dependsOn) visit(byId.get(dependency)!)
    visiting.delete(node.id)
    visited.add(node.id)
  }
  for (const node of nodes) visit(node)
  return nodes
}

export function resolveArguments(node: DagNode, values: Map<string, Json>): Record<string, Json> {
  return mapArguments(node.arguments, ref => {
    if (!values.has(ref.node)) throw new Error(`Missing result for ${ref.node}.`)
    let value = values.get(ref.node)!
    if (ref.pointer === '') return structuredClone(value)
    for (const escaped of ref.pointer.slice(1).split('/')) {
      const key = escaped.replace(/~1/gu, '/').replace(/~0/gu, '~')
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)
        || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(key))) {
        throw new Error(`Missing result path ${ref.node}${ref.pointer}.`)
      }
      value = (value as Record<string, Json>)[key]!
    }
    return structuredClone(value)
  }) as Record<string, Json>
}
