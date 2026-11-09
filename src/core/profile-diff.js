/**
 * Pure diff core for profile switching.
 *
 * Compares two GroupDocs while ignoring `version`/`revision` and reports what a
 * switch would change. This module stays free of locale/Intl and of the 100/300
 * display caps: the caller (profile preview UI) owns truncation, so every array
 * returned here is complete.
 */

const asArray = (value) => (Array.isArray(value) ? value : [])

const textOrNull = (value) => (typeof value === 'string' ? value : null)

const normalizeGroup = (group) => ({
  id: textOrNull(group?.id),
  parentId: group?.parentId ?? null,
  name: textOrNull(group?.name),
  icon: textOrNull(group?.icon),
  color: textOrNull(group?.color),
  colorHex: textOrNull(group?.colorHex),
  sessionIds: asArray(group?.sessionIds).slice(),
})

/** Strip metadata and optional-field shape noise so two docs can be compared. */
const normalizeDocForCompare = (doc) => ({
  groups: asArray(doc?.groups).map(normalizeGroup),
  ungrouped: asArray(doc?.ungrouped).slice(),
})

const sameList = (left, right) => {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

const sameGroup = (left, right) =>
  left.id === right.id &&
  left.parentId === right.parentId &&
  left.name === right.name &&
  left.icon === right.icon &&
  left.color === right.color &&
  left.colorHex === right.colorHex &&
  sameList(left.sessionIds, right.sessionIds)

/**
 * Structural equality ignoring `version`/`revision`. Group order, per-group
 * field values, sessionIds order and ungrouped order all count.
 */
const sameDocs = (a, b) => {
  const left = normalizeDocForCompare(a)
  const right = normalizeDocForCompare(b)
  if (left.groups.length !== right.groups.length) return false
  for (let index = 0; index < left.groups.length; index += 1) {
    if (!sameGroup(left.groups[index], right.groups[index])) return false
  }
  return sameList(left.ungrouped, right.ungrouped)
}

const groupPathMap = (doc) => {
  const byId = new Map()
  for (const group of asArray(doc?.groups)) {
    if (group && typeof group.id === 'string') byId.set(group.id, group)
  }
  const paths = new Map()
  const resolving = new Set()
  const resolve = (groupId) => {
    if (paths.has(groupId)) return paths.get(groupId)
    const group = byId.get(groupId)
    if (!group || resolving.has(groupId)) return null
    resolving.add(groupId)
    const parentId = group.parentId ?? null
    const parentPath = parentId === null ? null : resolve(parentId)
    const name = typeof group.name === 'string' ? group.name : ''
    const path = parentPath === null ? name : `${parentPath}/${name}`
    resolving.delete(groupId)
    paths.set(groupId, path)
    return path
  }
  for (const group of byId.values()) resolve(group.id)
  return paths
}

/** Depth-first group order following the tree, not the flat `groups` array order. */
const dfsGroups = (doc) => {
  const groups = asArray(doc?.groups).filter((group) => group && typeof group === 'object')
  const children = new Map()
  for (const group of groups) {
    const parentId = group.parentId ?? null
    if (!children.has(parentId)) children.set(parentId, [])
    children.get(parentId).push(group)
  }
  const ordered = []
  const seen = new Set()
  const visit = (parentId) => {
    for (const group of children.get(parentId) ?? []) {
      if (seen.has(group.id)) continue
      seen.add(group.id)
      ordered.push(group)
      visit(group.id)
    }
  }
  visit(null)
  for (const group of groups) {
    if (seen.has(group.id)) continue
    seen.add(group.id)
    ordered.push(group)
    visit(group.id)
  }
  return ordered
}

const pathOf = (paths, group) => paths.get(group.id) ?? (typeof group.name === 'string' ? group.name : '')

const parentOf = (group) => group.parentId ?? null

/**
 * Compare two documents for a profile-switch preview.
 *
 * Group matching is by id first, then by a path that is unique on both sides.
 * Session classification uses `liveSessionIds`; when that list is empty the
 * document memberships are used for the grouped/ungrouped counts and `stale`
 * stays empty because liveness is unknown.
 */
const diffDocs = (currentDoc, targetDoc, liveSessionIds = []) => {
  const currentGroups = asArray(currentDoc?.groups).filter((group) => group && typeof group === 'object')
  const targetGroups = asArray(targetDoc?.groups).filter((group) => group && typeof group === 'object')
  const currentPaths = groupPathMap(currentDoc)
  const targetPaths = groupPathMap(targetDoc)

  const targetById = new Map()
  for (const group of targetGroups) targetById.set(group.id, group)

  const pairs = []
  const matchedCurrent = new Set()
  const matchedTarget = new Set()
  for (const group of currentGroups) {
    const target = targetById.get(group.id)
    if (!target || matchedTarget.has(target.id)) continue
    pairs.push({ current: group, target, byPath: false })
    matchedCurrent.add(group.id)
    matchedTarget.add(target.id)
  }

  const unmatchedByPath = (groups, matched, paths) => {
    const byPath = new Map()
    for (const group of groups) {
      if (matched.has(group.id)) continue
      const path = pathOf(paths, group)
      if (!byPath.has(path)) byPath.set(path, [])
      byPath.get(path).push(group)
    }
    return byPath
  }
  const currentByPath = unmatchedByPath(currentGroups, matchedCurrent, currentPaths)
  const targetByPath = unmatchedByPath(targetGroups, matchedTarget, targetPaths)
  for (const [path, currentList] of currentByPath) {
    const targetList = targetByPath.get(path)
    if (!targetList || currentList.length !== 1 || targetList.length !== 1) continue
    pairs.push({ current: currentList[0], target: targetList[0], byPath: true })
    matchedCurrent.add(currentList[0].id)
    matchedTarget.add(targetList[0].id)
  }

  const added = dfsGroups(targetDoc)
    .filter((group) => !matchedTarget.has(group.id))
    .map((group) => pathOf(targetPaths, group))
  const removed = dfsGroups(currentDoc)
    .filter((group) => !matchedCurrent.has(group.id))
    .map((group) => pathOf(currentPaths, group))

  const currentOrder = new Map()
  for (const [index, group] of dfsGroups(currentDoc).entries()) currentOrder.set(group.id, index)
  const orderedPairs = [...pairs].sort(
    (left, right) => (currentOrder.get(left.current.id) ?? 0) - (currentOrder.get(right.current.id) ?? 0),
  )

  const changed = []
  for (const pair of orderedPairs) {
    // A path match already means same name and same place: only content can
    // differ, so renamed/moved stay false for it.
    const renamed = pair.byPath ? false : pair.current.name !== pair.target.name
    const moved = pair.byPath ? false : parentOf(pair.current) !== parentOf(pair.target)
    const appearance =
      textOrNull(pair.current.icon) !== textOrNull(pair.target.icon) ||
      textOrNull(pair.current.color) !== textOrNull(pair.target.color) ||
      textOrNull(pair.current.colorHex) !== textOrNull(pair.target.colorHex)
    if (!renamed && !moved && !appearance) continue
    changed.push({
      id: pair.target.id,
      from: pathOf(currentPaths, pair.current),
      to: pathOf(targetPaths, pair.target),
      renamed,
      moved,
      appearance,
    })
  }

  const pairByCurrent = new Map()
  const pairByTarget = new Map()
  for (const pair of pairs) {
    pairByCurrent.set(pair.current.id, pair)
    pairByTarget.set(pair.target.id, pair)
  }
  const staysUnder = (pair, currentParentId, targetParentId) =>
    parentOf(pair.current) === currentParentId && parentOf(pair.target) === targetParentId
  const childrenDiffer = (currentParentId, targetParentId) => {
    const currentSequence = []
    for (const group of currentGroups) {
      const pair = pairByCurrent.get(group.id)
      if (!pair || !staysUnder(pair, currentParentId, targetParentId)) continue
      currentSequence.push(pair.target.id)
    }
    const targetSequence = []
    for (const group of targetGroups) {
      const pair = pairByTarget.get(group.id)
      if (!pair || !staysUnder(pair, currentParentId, targetParentId)) continue
      targetSequence.push(pair.target.id)
    }
    return !sameList(currentSequence, targetSequence)
  }
  let reordered = childrenDiffer(null, null)
  if (!reordered) {
    for (const pair of pairs) {
      // Compare each logical group's own children, so path-matched parents whose
      // ids differ still get their sibling order checked.
      if (childrenDiffer(pair.current.id, pair.target.id)) {
        reordered = true
        break
      }
    }
  }

  const currentOwner = new Map()
  for (const group of currentGroups) {
    for (const sessionId of asArray(group.sessionIds)) currentOwner.set(sessionId, pathOf(currentPaths, group))
  }
  const targetOwner = new Map()
  for (const group of targetGroups) {
    for (const sessionId of asArray(group.sessionIds)) targetOwner.set(sessionId, pathOf(targetPaths, group))
  }

  const live = new Set()
  const liveInput = Array.isArray(liveSessionIds) || liveSessionIds instanceof Set ? liveSessionIds : []
  for (const sessionId of liveInput) {
    if (typeof sessionId === 'string' && sessionId !== '') live.add(sessionId)
  }
  const hasLive = live.size > 0

  const universe = new Set(live)
  for (const sessionId of currentOwner.keys()) universe.add(sessionId)
  for (const sessionId of targetOwner.keys()) universe.add(sessionId)
  const sessionOrder = [...universe].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

  const moved = []
  const newlyGrouped = []
  const ungrouped = []
  const stale = []
  for (const sessionId of sessionOrder) {
    const from = currentOwner.get(sessionId) ?? null
    const to = targetOwner.get(sessionId) ?? null
    if (from !== null && to !== null && from !== to) moved.push({ sessionId, from, to })
    else if (from === null && to !== null) newlyGrouped.push({ sessionId, to })
    else if (from !== null && to === null && live.has(sessionId)) ungrouped.push({ sessionId, from })
    if (to !== null && hasLive && !live.has(sessionId)) stale.push(sessionId)
  }

  let groupedCurrent = 0
  let groupedTarget = 0
  let ungroupedCurrent = 0
  let ungroupedTarget = 0
  if (hasLive) {
    for (const sessionId of live) {
      if (currentOwner.has(sessionId)) groupedCurrent += 1
      if (targetOwner.has(sessionId)) groupedTarget += 1
    }
    ungroupedCurrent = live.size - groupedCurrent
    ungroupedTarget = live.size - groupedTarget
  } else {
    groupedCurrent = currentOwner.size
    groupedTarget = targetOwner.size
    ungroupedCurrent = asArray(currentDoc?.ungrouped).length
    ungroupedTarget = asArray(targetDoc?.ungrouped).length
  }

  return {
    summary: {
      groups: {
        current: currentGroups.length,
        target: targetGroups.length,
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        reordered,
      },
      grouped: { current: groupedCurrent, target: groupedTarget },
      ungrouped: { current: ungroupedCurrent, target: ungroupedTarget },
      sessions: {
        moved: moved.length,
        newlyGrouped: newlyGrouped.length,
        ungrouped: ungrouped.length,
        stale: stale.length,
      },
    },
    groups: { added, removed, changed, reordered },
    sessions: { moved, newlyGrouped, ungrouped, stale },
    truncated: { groups: false, sessions: false },
  }
}

export { diffDocs, normalizeDocForCompare, sameDocs }
