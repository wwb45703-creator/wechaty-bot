/** Patch a JSON value without reformatting user-authored role strings or sibling keys. */
export function patchJsonValue(source, keys, value) {
  JSON.parse(source)
  const ranges = new Map()
  let at = 0
  const space = () => { while (/\s/.test(source[at] || '') && at < source.length) at++ }
  const quoted = () => {
    const start = at++
    while (at < source.length) { if (source[at++] === '\\') at++; else if (source[at - 1] === '"') break }
    return JSON.parse(source.slice(start, at))
  }
  function visit(path) {
    space(); const start = at
    if (source[at] === '{') {
      at++; space()
      while (source[at] !== '}') {
        const key = quoted(); space(); at++
        visit([...path, key]); space()
        if (source[at] !== ',') break
        at++; space()
      }
      at++
    } else if (source[at] === '[') {
      at++; space(); let index = 0
      while (source[at] !== ']') {
        visit([...path, index++]); space()
        if (source[at] !== ',') break
        at++; space()
      }
      at++
    } else if (source[at] === '"') quoted()
    else { while (at < source.length && !/[\s,\]}]/.test(source[at])) at++ }
    ranges.set(JSON.stringify(path), [start, at])
  }
  visit([])
  const range = ranges.get(JSON.stringify(keys)), encoded = JSON.stringify(value)
  if (range) return source.slice(0, range[0]) + encoded + source.slice(range[1])
  const parent = ranges.get(JSON.stringify(keys.slice(0, -1)))
  if (!parent || source[parent[0]] !== '{') throw new Error('配置补丁的父对象不存在')
  const body = source.slice(parent[0] + 1, parent[1] - 1), nonempty = body.trim().length > 0
  const line = source.slice(0, parent[0]).split('\n').at(-1).match(/^\s*/)?.[0] || ''
  const addition = `${nonempty ? ',' : ''}\n${line}  ${JSON.stringify(keys.at(-1))}: ${encoded}`
  const end = parent[1] - 1 - (body.match(/\s*$/)?.[0].length || 0)
  return source.slice(0, end) + addition + source.slice(end)
}
