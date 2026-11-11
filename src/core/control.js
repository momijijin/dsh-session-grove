/**
 * Pure AI-control protocol core.
 *
 * This module owns the stable operation vocabulary and GroupDoc transitions.
 * It has no HTTP, DSH, React, storage, revision or audit concerns: the outer
 * adapter is responsible for auth, opt-in gating, CAS, idempotency and logs.
 *
 * Operations are deliberately structural. There is no raw-document write:
 * every mutation goes through the shared GroupDoc mutators and validateDoc.
 */
import {
  assignSession,
  childrenOf,
  cloneDoc,
  createGroup,
  deleteGroupTo,
  groupColor,
  groupColorHex,
  hasControlChars,
  isKnownColor,
  isKnownIcon,
  moveGroup,
  normalizeColorHex,
  renameGroup,
  setGroupArchived,
  setGroupColor,
  setGroupColorHex,
  setGroupIcon,
  validateDoc,
} from '../shared/model.js'
import {
  ARCHIVE_FROZEN,
  archivedInfo,
  effectiveArchived,
  findArchiveViolation,
  GROUP_ARCHIVED,
  GROUP_CONTAINS_ARCHIVED,
  GROUP_DESTINATION_ARCHIVED,
  GROUP_POSITION_LOCKED,
  hasArchivedDescendant,
} from '../shared/archive.js'
import { GROUP_COLORS, GROUP_ICONS, MAX_DEPTH, MAX_GROUP_NAME } from '../shared/constants.js'

export const CONTROL_PROTOCOL = 1
export const MAX_CONTROL_OPERATIONS = 64

/**
 * Operation/result codes that describe an archive-state conflict (N6): the HTTP
 * control routes must answer 409 for these, while schema/type/index mistakes
 * stay 422. Reuses the shared error-code constants from `archive.js`.
 */
export const ARCHIVE_CONFLICT_CODES = Object.freeze([
  GROUP_ARCHIVED,
  GROUP_CONTAINS_ARCHIVED,
  GROUP_DESTINATION_ARCHIVED,
  GROUP_POSITION_LOCKED,
  ARCHIVE_FROZEN,
])

export const isArchiveConflictCode = (code) => ARCHIVE_CONFLICT_CODES.includes(code)

const fail = (code, message, operationIndex, extra = {}) => ({
  ok: false,
  code,
  message,
  operationIndex,
  ...extra,
})

const isPlainRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const OPERATION_SCHEMAS = Object.freeze({
  'group.create': {
    name: { type: 'string', required: true, nonEmpty: true },
    parentId: { type: 'nullableId' },
    index: { type: 'index' },
    icon: { type: 'string', nonEmpty: true },
    color: { type: 'string', nonEmpty: true },
    colorHex: { type: 'string', nonEmpty: true },
  },
  'group.rename': {
    groupId: { type: 'string', required: true, nonEmpty: true },
    name: { type: 'string', required: true, nonEmpty: true },
  },
  'group.update': {
    groupId: { type: 'string', required: true, nonEmpty: true },
    icon: { type: 'string', nonEmpty: true },
    color: { type: 'string', nonEmpty: true },
    colorHex: { type: 'string', nonEmpty: true },
  },
  // Deliberately separate from `group.update`: the archived switch has its own
  // semantics (never cascades, always legal on its own) and `group.update`
  // must keep accepting only icon/color/colorHex.
  'group.archive': {
    groupId: { type: 'string', required: true, nonEmpty: true },
    archived: { type: 'boolean', required: true },
  },
  'group.move': {
    groupId: { type: 'string', required: true, nonEmpty: true },
    parentId: { type: 'nullableId' },
    index: { type: 'index' },
  },
  'group.delete': {
    groupId: { type: 'string', required: true, nonEmpty: true },
    destinationId: { type: 'nullableId' },
  },
  'session.assign': {
    sessionId: { type: 'string', required: true, nonEmpty: true },
    groupId: { type: 'nullableId' },
    index: { type: 'index' },
  },
})

const receivedType = (value) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value

const validateField = (operation, index, field, spec) => {
  const value = operation[field]
  if (value === undefined) {
    if (spec.required === true) {
      return fail('invalid-operation', `missing required field "${field}"`, index, {
        field,
        expected: spec.type,
      })
    }
    return null
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string' || (spec.nonEmpty === true && value.length === 0)) {
      return fail('invalid-operation', `field "${field}" must be a${spec.nonEmpty === true ? ' non-empty' : ''} string`, index, {
        field,
        expected: spec.nonEmpty === true ? 'non-empty string' : 'string',
        receivedType: receivedType(value),
      })
    }
    return null
  }
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') {
      return fail('invalid-operation', `field "${field}" must be a boolean`, index, {
        field,
        expected: 'boolean',
        receivedType: receivedType(value),
      })
    }
    return null
  }
  if (spec.type === 'nullableId') {
    if (value !== null && (typeof value !== 'string' || value.length === 0)) {
      return fail('invalid-operation', `field "${field}" must be a non-empty string or null`, index, {
        field,
        expected: 'non-empty string | null',
        receivedType: receivedType(value),
      })
    }
    return null
  }
  if (spec.type === 'index') {
    if (!Number.isInteger(value) || value < 0) {
      return fail('invalid-operation', `field "${field}" must be a non-negative integer`, index, {
        field,
        expected: 'non-negative integer',
        receivedType: receivedType(value),
      })
    }
  }
  return null
}

/**
 * Semantic enum/format checks for group appearance fields. The shared
 * mutators still normalize persisted/legacy docs, but control input is
 * user intent and must not be silently rewritten.
 */
const validateGroupAppearance = (operation, index) => {
  if (operation.op !== 'group.create' && operation.op !== 'group.update') return null
  if (operation.color !== undefined && operation.colorHex !== undefined) {
    return fail('invalid-operation', 'color and colorHex are mutually exclusive', index, {
      field: 'color|colorHex',
      expected: 'choose one color representation',
    })
  }
  if (operation.icon !== undefined && !isKnownIcon(operation.icon)) {
    return fail('invalid-icon', `unknown icon ${JSON.stringify(operation.icon)}`, index, {
      field: 'icon',
      allowed: [...GROUP_ICONS],
    })
  }
  if (operation.color !== undefined && !isKnownColor(operation.color)) {
    return fail('invalid-color', `unknown palette color ${JSON.stringify(operation.color)}`, index, {
      field: 'color',
      allowed: [...GROUP_COLORS],
    })
  }
  if (operation.colorHex !== undefined && normalizeColorHex(operation.colorHex) === null) {
    return fail('invalid-color', 'colorHex must be #RGB, RGB, #RRGGBB or RRGGBB (no alpha)', index, {
      field: 'colorHex',
      expected: '#RGB | RGB | #RRGGBB | RRGGBB',
      canonical: '#rrggbb',
    })
  }
  return null
}

const validateOperation = (operation, index) => {
  if (!isPlainRecord(operation)) {
    return fail('invalid-operation', 'operation must be an object', index, { expected: 'object' })
  }
  const schema = OPERATION_SCHEMAS[operation.op]
  if (schema === undefined) {
    return fail('unknown-operation', `unknown operation ${JSON.stringify(operation.op)}`, index, {
      field: 'op',
      expected: Object.keys(OPERATION_SCHEMAS),
    })
  }
  const allowed = new Set(['op', ...Object.keys(schema)])
  const unexpected = Object.keys(operation).find((key) => !allowed.has(key))
  if (unexpected !== undefined) {
    return fail('invalid-operation', `unexpected field "${unexpected}"`, index, {
      field: unexpected,
      expected: 'no unknown fields',
    })
  }
  for (const [field, spec] of Object.entries(schema)) {
    const invalid = validateField(operation, index, field, spec)
    if (invalid !== null) return invalid
  }
  if (operation.op === 'group.update' && operation.icon === undefined && operation.color === undefined && operation.colorHex === undefined) {
    return fail('invalid-operation', 'group.update requires icon, color, or colorHex', index, {
      field: 'icon|color|colorHex',
      expected: 'at least one update field',
    })
  }
  const appearance = validateGroupAppearance(operation, index)
  if (appearance !== null) return appearance
  return null
}

/** Read-only state for an AI client; IDs are the stable API surface. */
const pathOfGroup = (doc, group) => {
  const names = []
  const seen = new Set()
  let current = group
  while (current) {
    if (seen.has(current.id)) break
    seen.add(current.id)
    names.unshift(current.name)
    current = current.parentId === null ? null : doc.groups.find((entry) => entry.id === current.parentId)
  }
  return names
}

export const buildControlState = (doc, revision) => ({
  protocol: CONTROL_PROTOCOL,
  revision,
  groups: doc.groups.map((group) => {
    const archive = archivedInfo(doc, group.id)
    return {
      id: group.id,
      path: pathOfGroup(doc, group),
      name: group.name,
      parentId: group.parentId,
      icon: group.icon,
      color: groupColor(group),
      ...(groupColorHex(group) ? { colorHex: groupColorHex(group) } : {}),
      sessionIds: [...group.sessionIds],
      // 0.4.0-beta.62 (SPEC §7): own flag plus derived inheritance. `pathOnly`
      // is view state and is deliberately not exposed here.
      archived: archive.own,
      effectiveArchived: archive.effective,
      archivedBy: archive.archivedBy,
    }
  }),
  ungrouped: [...doc.ungrouped],
})

/**
 * Resolve a root-to-leaf display path to exactly one group id.
 * Duplicate siblings are ambiguous; never pick one silently.
 */
export const resolveGroupPath = (doc, path) => {
  if (!Array.isArray(path) || path.length === 0 || path.length > MAX_DEPTH) {
    return fail('invalid-path', `path must be an array of 1..${String(MAX_DEPTH)} non-empty strings`, -1, {
      field: 'path',
    })
  }
  if (path.some((name) => typeof name !== 'string' || name.length === 0 || name.length > MAX_GROUP_NAME || hasControlChars(name))) {
    return fail('invalid-path', 'every path segment must be a non-empty control-character-free string within the name limit', -1, {
      field: 'path',
    })
  }
  let parentId = null
  for (let depth = 0; depth < path.length; depth += 1) {
    const matches = childrenOf(doc, parentId).filter((group) => group.name === path[depth])
    if (matches.length === 0) {
      return fail('group-not-found', `group path not found at depth ${String(depth)}`, -1, {
        field: 'path',
        path: path.slice(0, depth + 1),
        depth,
        missingName: path[depth],
      })
    }
    if (matches.length > 1) {
      return fail('ambiguous-path', `group path is ambiguous at depth ${String(depth)}`, -1, {
        field: 'path',
        path: path.slice(0, depth + 1),
        depth,
        candidates: matches.map((group) => ({ id: group.id, path: pathOfGroup(doc, group), parentId: group.parentId })),
      })
    }
    parentId = matches[0].id
  }
  return { ok: true, groupId: parentId, path: [...path] }
}

/**
 * Explicit archive guards (SPEC §7, 0.4.0-beta.62).
 *
 * The shared model mutators already enforce the frozen-subtree invariant, but
 * the control layer needs stable codes/groupId/field *before* the mutation:
 * the invariant alone cannot express every intent (for example deleting into an
 * archived empty destination changes no fingerprint) and per-operation guards
 * give the caller a precise `operationIndex`. These guards run against the
 * current batch doc, so operations are rejected in order.
 */
const archiveGuard = (doc, operation) => {
  const parentId = operation.parentId ?? null
  switch (operation.op) {
    case 'group.create':
      if (parentId !== null && effectiveArchived(doc, parentId)) {
        return { code: GROUP_ARCHIVED, groupId: parentId, field: 'parentId' }
      }
      return null
    case 'group.rename':
    case 'group.update':
      if (effectiveArchived(doc, operation.groupId)) {
        return { code: GROUP_ARCHIVED, groupId: operation.groupId, field: 'groupId' }
      }
      return null
    case 'group.move': {
      // An unknown source is a mutator concern (`group-not-found`), not an
      // archive conflict: classify only existing groups here.
      if (!doc.groups.some((group) => group.id === operation.groupId)) return null
      if (effectiveArchived(doc, operation.groupId)) {
        return { code: GROUP_ARCHIVED, groupId: operation.groupId, field: 'groupId' }
      }
      if (hasArchivedDescendant(doc, operation.groupId)) {
        return { code: GROUP_CONTAINS_ARCHIVED, groupId: operation.groupId, field: 'groupId' }
      }
      if (parentId !== null && effectiveArchived(doc, parentId)) {
        return { code: GROUP_DESTINATION_ARCHIVED, groupId: parentId, field: 'parentId' }
      }
      return null
    }
    case 'group.delete': {
      if (!doc.groups.some((group) => group.id === operation.groupId)) return null
      if (effectiveArchived(doc, operation.groupId)) {
        return { code: GROUP_ARCHIVED, groupId: operation.groupId, field: 'groupId' }
      }
      if (hasArchivedDescendant(doc, operation.groupId)) {
        return { code: GROUP_CONTAINS_ARCHIVED, groupId: operation.groupId, field: 'groupId' }
      }
      const destinationId = operation.destinationId ?? null
      if (destinationId !== null && effectiveArchived(doc, destinationId)) {
        return { code: GROUP_DESTINATION_ARCHIVED, groupId: destinationId, field: 'destinationId' }
      }
      return null
    }
    case 'session.assign': {
      const source = doc.groups.find(
        (group) => Array.isArray(group.sessionIds) && group.sessionIds.includes(operation.sessionId),
      )
      if (source !== undefined && effectiveArchived(doc, source.id)) {
        return { code: GROUP_ARCHIVED, groupId: source.id, field: 'sessionId' }
      }
      const groupId = operation.groupId ?? null
      if (groupId !== null && effectiveArchived(doc, groupId)) {
        return { code: GROUP_DESTINATION_ARCHIVED, groupId, field: 'groupId' }
      }
      return null
    }
    default:
      return null
  }
}

/** Structured per-operation error; the batch loop adds `operationIndex`/`changes`. */
const archiveError = ({ code, groupId, field }) => Object.assign(new Error(code), { code, groupId, field })

const applyOne = (doc, operation, allowDestructive) => {
  const op = operation?.op
  // The destructive gate is an authorization check and keeps precedence over
  // archive-state conflicts, preserving the historic `operation-failed` answer.
  const guard = op === 'group.delete' && !allowDestructive ? null : archiveGuard(doc, operation)
  if (guard !== null) throw archiveError(guard)
  switch (op) {
    case 'group.create': {
      const next = createGroup(doc, {
        name: operation.name,
        parentId: operation.parentId ?? null,
        index: operation.index,
        icon: operation.icon,
        color: operation.color,
        colorHex: operation.colorHex,
      })
      // A plan and its later apply run the create independently, so a generated
      // id is not stable across the two calls. Do not expose it as if it were.
      return { doc: next, change: { op, created: true } }
    }
    case 'group.rename':
      return { doc: renameGroup(doc, operation.groupId, operation.name), change: { op, groupId: operation.groupId } }
    case 'group.update': {
      let next = doc
      if (operation.icon !== undefined) next = setGroupIcon(next, operation.groupId, operation.icon)
      if (operation.color !== undefined) next = setGroupColor(next, operation.groupId, operation.color)
      if (operation.colorHex !== undefined) next = setGroupColorHex(next, operation.groupId, operation.colorHex)
      if (next === doc) throw new Error('no-update-fields')
      return { doc: next, change: { op, groupId: operation.groupId } }
    }
    case 'group.move':
      return {
        doc: moveGroup(doc, operation.groupId, operation.parentId ?? null, operation.index),
        change: { op, groupId: operation.groupId },
      }
    case 'group.archive': {
      const next = setGroupArchived(doc, operation.groupId, operation.archived)
      // The shared mutator returns the input doc for a same-value switch; that
      // operation is a no-op and must not be reported as a change.
      if (next === doc) return { doc, change: null }
      return { doc: next, change: { op, groupId: operation.groupId, archived: operation.archived } }
    }
    case 'group.delete':
      if (!allowDestructive) throw new Error('destructive-disabled')
      return {
        doc: deleteGroupTo(doc, operation.groupId, operation.destinationId ?? null),
        change: { op, groupId: operation.groupId },
      }
    case 'session.assign':
      return {
        doc: assignSession(doc, operation.sessionId, operation.groupId ?? null, operation.index),
        change: { op, sessionId: operation.sessionId },
      }
    default:
      throw new Error('unknown-operation')
  }
}

/**
 * Plan/apply a list of structural operations. The returned doc is a candidate;
 * the host adapter must still perform revision CAS and atomic persistence.
 *
 * @param {object} doc
 * @param {Array<object>} operations
 * @param {{allowDestructive?: boolean}} [options]
 */
export const applyControlOperations = (doc, operations, options = {}) => {
  if (!Array.isArray(operations) || operations.length === 0) {
    return fail('operations-required', 'operations must be a non-empty array', -1)
  }
  if (operations.length > MAX_CONTROL_OPERATIONS) {
    return fail('too-many-operations', `at most ${String(MAX_CONTROL_OPERATIONS)} operations are allowed`, -1)
  }
  const allowDestructive = options.allowDestructive === true
  let next = cloneDoc(doc)
  const changes = []
  for (let index = 0; index < operations.length; index += 1) {
    const invalid = validateOperation(operations[index], index)
    if (invalid !== null) return invalid
    try {
      const result = applyOne(next, operations[index], allowDestructive)
      next = result.doc
      if (result.change !== null) changes.push(result.change)
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : null
      if (code !== null) {
        // Archive invariant errors thrown by the shared mutators already carry
        // a stable code/groupId/field. Keep them instead of flattening every
        // failure into `operation-failed` (SPEC §6.4/§7).
        const extra = { changes }
        if (typeof error.groupId === 'string') extra.groupId = error.groupId
        if (typeof error.field === 'string') extra.field = error.field
        return fail(code, error instanceof Error ? error.message : code, index, extra)
      }
      if (operations[index].op === 'group.archive' && error instanceof Error && error.message === 'group-not-found') {
        return fail('group-not-found', 'group not found', index, {
          groupId: operations[index].groupId,
          field: 'groupId',
          changes,
        })
      }
      return fail('operation-failed', error instanceof Error ? error.message : String(error), index, {
        changes,
      })
    }
  }
  try {
    const validation = validateDoc(next)
    if (!validation.ok) {
      return fail('invalid-result', validation.errors.join('; ') || 'invalid doc', -1, { changes })
    }
  } catch (error) {
    return fail('invalid-result', error instanceof Error ? error.message : String(error), -1, { changes })
  }
  // Whole-batch terminal check: the before-state is the *original* doc, so a
  // sequence like `[unarchive, rename]` cannot hide a frozen-subtree edit
  // behind individually legal steps. A violation rejects the entire batch.
  const violation = findArchiveViolation(doc, next)
  if (violation !== null) {
    return fail(violation.code, violation.code, -1, {
      groupId: violation.groupId,
      field: violation.field,
      changes,
    })
  }
  if (changes.length === 0) return fail('no-change', 'operations produced no change', -1)
  return { ok: true, doc: next, changes }
}

/** Option list for a future skill; kept in core so adapter/skill share one vocabulary. */
export const CONTROL_OPERATIONS = Object.freeze([
  'group.create',
  'group.rename',
  'group.update',
  'group.archive',
  'group.move',
  'group.delete',
  'session.assign',
])
