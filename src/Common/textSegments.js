// 文本分段模块：笔记内容按 UTF-8 字节切成若干段（segment）。
// 真正的分段：段文本不常驻内存，渲染时按需从磁盘读取当前窗口内的段，
// 编辑只加载受影响的段，保存时流式重写（脏段取内存、干净段从旧文件读回）。
// 段表（每段字节数/字符数）记在 note_<id>.txt.idx，打开时 O(1)；
// 若索引缺失或失效，则扫描一遍文件重建段表（只记元数据、不驻留文本）。
//
// 文件仍是纯 UTF-8 文本，保证 index 预览、互连读整篇、二维码等旧路径不受影响。

const DEFAULT_SEG_BYTES = 128
// 一个段至少要能装下最宽的 UTF-8 字符（4 字节），否则段表无法推进
const MIN_SEG_BYTES = 4

// 规整段长参数：非正数/非数字回落到默认值，过小的正数抬到最小值（至少能装一个 4 字节字符）
function normSegBytes(value) {
  const n = typeof value === 'number' ? Math.floor(value) : 0
  if (!(n > 0)) return DEFAULT_SEG_BYTES
  return n < MIN_SEG_BYTES ? MIN_SEG_BYTES : n
}

// ===== UTF-8 基础 =====

// 计算字符串的 UTF-8 字节数。
// 注意：只有「高位代理 + 低位代理」才按 4 字节计；孤立代理会被编码器写成
// 替换字符 U+FFFD（3 字节），这里必须同样按 3 字节计，否则段表与磁盘不一致。
export function utf8ByteLength(str) {
  let len = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c < 0x80) {
      len += 1
    } else if (c < 0x800) {
      len += 2
    } else if (c >= 0xD800 && c <= 0xDBFF) {
      const d = i + 1 < str.length ? str.charCodeAt(i + 1) : 0
      if (d >= 0xDC00 && d <= 0xDFFF) {
        len += 4
        i++
      } else {
        len += 3
      }
    } else {
      len += 3
    }
  }
  return len
}

// 解码 UTF-8 字节区间 [start, end)；
// 末尾若是不完整的多字节序列则停止，consumed 表示真正消费到的字节数。
export function decodeUtf8(bytes, start, end) {
  let i = typeof start === 'number' ? start : 0
  const stop = typeof end === 'number' ? end : bytes.length
  let out = ''
  while (i < stop) {
    const b0 = bytes[i]
    if (b0 < 0x80) {
      out += String.fromCharCode(b0)
      i++
      continue
    }
    let n
    if ((b0 & 0xE0) === 0xC0) {
      n = 2
    } else if ((b0 & 0xF0) === 0xE0) {
      n = 3
    } else if ((b0 & 0xF8) === 0xF0) {
      n = 4
    } else {
      // 非法的前导字节（例如起点落在续字节上）：跳过，等待下一个前导
      i++
      continue
    }
    if (i + n > stop) {
      // 结尾不完整，留给下次读取
      break
    }
    let cp
    if (n === 2) {
      cp = ((b0 & 0x1F) << 6) | (bytes[i + 1] & 0x3F)
    } else if (n === 3) {
      cp = ((b0 & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)
    } else {
      cp =
        ((b0 & 0x07) << 18) |
        ((bytes[i + 1] & 0x3F) << 12) |
        ((bytes[i + 2] & 0x3F) << 6) |
        (bytes[i + 3] & 0x3F)
    }
    if (cp > 0xFFFF) {
      cp -= 0x10000
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF))
    } else {
      out += String.fromCharCode(cp)
    }
    i += n
  }
  return { text: out, consumed: i - start }
}

// 把整段文本按 UTF-8 字节数切块（贪心：能放进 limit 就放，放不下开新段），
// 保证不切断代理对。扫描文件重建段表时使用同一规则。
export function splitTextByBytes(text, segBytes) {
  const limit = normSegBytes(segBytes)
  const chunks = []
  const src = text || ''
  if (src.length === 0) {
    return ['']
  }
  let startIdx = 0
  let bytes = 0
  let i = 0
  while (i < src.length) {
    const c = src.charCodeAt(i)
    let cb
    let step = 1
    if (c < 0x80) {
      cb = 1
    } else if (c < 0x800) {
      cb = 2
    } else if (c >= 0xD800 && c <= 0xDBFF) {
      const d = i + 1 < src.length ? src.charCodeAt(i + 1) : 0
      if (d >= 0xDC00 && d <= 0xDFFF) {
        cb = 4
        step = 2
      } else {
        // 孤立高位代理：落盘时被替换为 U+FFFD（3 字节）
        cb = 3
      }
    } else {
      cb = 3
    }
    if (bytes + cb > limit && i > startIdx) {
      chunks.push(src.slice(startIdx, i))
      startIdx = i
      bytes = 0
    }
    bytes += cb
    i += step
  }
  if (startIdx < src.length) {
    chunks.push(src.slice(startIdx))
  }
  if (chunks.length === 0) {
    chunks.push('')
  }
  return chunks
}

// ===== 文档模型 =====
// doc = {
//   uri, idxUri, segBytes,
//   segments: [{ byteLen, charLen, diskOffset, text?, dirty }],
//   starts: [char 前缀和], charCount, totalBytes,
//   window: {from, to}, dirty
// }

function makeSegment(text, dirty) {
  return {
    byteLen: utf8ByteLength(text || ''),
    charLen: (text || '').length,
    diskOffset: 0,
    text: typeof text === 'string' ? text : undefined,
    dirty: !!dirty,
  }
}

// 重新计算字符前缀和、总字符数、总字节数
function reindex(doc) {
  const segs = doc.segments
  const starts = new Array(segs.length + 1)
  starts[0] = 0
  let chars = 0
  let bytes = 0
  for (let i = 0; i < segs.length; i++) {
    chars += segs[i].charLen
    bytes += segs[i].byteLen
    starts[i + 1] = chars
  }
  doc.starts = starts
  doc.charCount = chars
  doc.totalBytes = bytes
}

export function makeDoc(segBytes, uri) {
  const doc = {
    uri: uri || '',
    idxUri: uri ? uri + '.idx' : '',
    segBytes: normSegBytes(segBytes),
    segments: [],
    starts: [0],
    charCount: 0,
    totalBytes: 0,
    window: { from: 0, to: 0 },
    dirty: false,
  }
  doc.segments.push(makeSegment('', false))
  reindex(doc)
  return doc
}

// 由已有全文创建文档（恢复笔记 / 兼容旧传参）：所有段都在内存且标脏
export function createDocFromText(text, segBytes, uri) {
  const doc = makeDoc(segBytes, uri)
  const src = text || ''
  const parts = splitTextByBytes(src, doc.segBytes)
  doc.segments = parts.map((p) => makeSegment(p, true))
  doc.dirty = true
  reindex(doc)
  return doc
}

// 绝对字符位置 -> { index, offset }
export function locate(doc, pos) {
  const starts = doc.starts
  const n = doc.segments.length
  if (n === 0) return { index: 0, offset: 0 }
  if (typeof pos !== 'number' || pos !== pos) pos = 0
  if (pos < 0) pos = 0
  if (pos > doc.charCount) pos = doc.charCount
  let lo = 0
  let hi = n - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= pos) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return { index: ans, offset: pos - starts[ans] }
}

// 取某段已加载文本（未加载返回 ''）
export function segText(doc, index) {
  const seg = doc.segments[index]
  if (!seg || typeof seg.text !== 'string') return ''
  return seg.text
}

export function isLoaded(doc, index) {
  const seg = doc.segments[index]
  return !!seg && typeof seg.text === 'string'
}

// 取 [a, b) 区间的文本（仅使用已加载的段，调用前需保证窗口段已加载）
export function getRange(doc, a, b) {
  if (!doc || b <= a) return ''
  const sa = locate(doc, a)
  const sb = locate(doc, b)
  if (sa.index === sb.index) {
    return segText(doc, sa.index).slice(sa.offset, sb.offset)
  }
  let out = segText(doc, sa.index).slice(sa.offset)
  for (let i = sa.index + 1; i < sb.index; i++) {
    out += segText(doc, i)
  }
  out += segText(doc, sb.index).slice(0, sb.offset)
  return out
}

// ===== 磁盘读取 =====

function importFile() {
  return import('@system.file').then((file) => file.default || file)
}

function idxUriOf(uri) {
  return uri + '.idx'
}

function writeIdx(doc, info) {
  if (!doc || !doc.uri) return
  const payload = JSON.stringify({
    v: 1,
    segBytes: doc.segBytes,
    totalBytes: doc.totalBytes,
    mtime: (info && info.lastModifiedTime) || 0,
    segs: doc.segments.map((s) => [s.byteLen, s.charLen]),
  })
  importFile()
    .then((f) => {
      f.writeText({
        uri: doc.idxUri,
        text: payload,
        success: () => {},
        fail: (data, code) => console.warn('写入分段索引失败（不影响笔记内容，下次打开会重建）:', doc.idxUri, code),
      })
    })
    .catch((err) => {
      console.warn('写入分段索引异常（不影响笔记内容）:', doc.idxUri, err)
    })
}

// 打开笔记：优先读 idx 建段表，否则扫描文件重建
export function openDoc(uri, segBytes, callback) {
  const limit = normSegBytes(segBytes)
  importFile()
    .then((f) => {
      f.get({
        uri: uri,
        success: (info) => {
          const size = (info && info.length) || 0
          const doc = makeDoc(limit, uri)
          if (size <= 0) {
            if (callback) callback(null, doc)
            return
          }
          f.readText({
            uri: idxUriOf(uri),
            success: (res) => {
              const segs = parseIdx(res && res.text, limit, size, info && info.lastModifiedTime)
              if (segs) {
                doc.segments = segs
                reindex(doc)
                if (callback) callback(null, doc)
              } else {
                scanFile(f, uri, size, limit, doc, info, callback)
              }
            },
            fail: () => scanFile(f, uri, size, limit, doc, info, callback),
          })
        },
        fail: (data, code) => {
          // 只有 301（文件不存在）才当作空文档；I/O 错误等必须上报，
          // 否则编辑页会显示空笔记，用户保存后原笔记被覆盖。
          if (code === 301) {
            if (callback) callback(null, makeDoc(limit, uri))
            return
          }
          if (callback) callback(new Error('openDoc get fail ' + code))
        },
      })
    })
    .catch((err) => {
      if (callback) callback(err)
    })
}

function parseIdx(text, segBytes, size, mtime) {
  if (!text) return null
  try {
    const data = JSON.parse(text)
    if (!data || data.v !== 1) return null
    if (data.segBytes !== segBytes) return null
    if (!Array.isArray(data.segs) || data.segs.length === 0) return null
    // 文件被外部改动（大小相同但 mtime 变了）时判定失效
    if (mtime && data.mtime && data.mtime !== mtime) return null
    let total = 0
    const segs = []
    for (let i = 0; i < data.segs.length; i++) {
      const pair = data.segs[i]
      if (!pair || typeof pair[0] !== 'number' || typeof pair[1] !== 'number') return null
      const byteLen = pair[0]
      const charLen = pair[1]
      // 结构自洽性校验：整数、非负、且字节数与字符数落在 UTF-8 的取值范围内
      // （1~3 字节/字符，代理对 2 字符 4 字节）。挡掉明显被改坏的段表。
      if (!isFinite(byteLen) || !isFinite(charLen)) return null
      if (byteLen < 0 || charLen < 0 || byteLen % 1 !== 0 || charLen % 1 !== 0) return null
      // charLen === 0 允许 byteLen > 0：文件尾部不是完整 UTF-8 时的兜底段
      if (charLen > 0 && (byteLen < charLen || byteLen > charLen * 4)) return null
      segs.push({ byteLen: byteLen, charLen: charLen, diskOffset: total, text: undefined, dirty: false })
      total += byteLen
    }
    if (total !== size) return null
    if (typeof data.totalBytes === 'number' && data.totalBytes !== size) return null
    return segs
  } catch (e) {
    return null
  }
}

// 扫描文件重建段表（只记字节/字符数，丢弃文本）
function scanFile(f, uri, size, segBytes, doc, info, callback) {
  let pos = 0
  const segs = []
  const step = () => {
    if (pos >= size) {
      finish()
      return
    }
    const want = Math.min(segBytes, size - pos)
    f.readArrayBuffer({
      uri: uri,
      position: pos,
      length: want,
      success: (data) => {
        try {
          const bytes = new Uint8Array(data.buffer)
          if (bytes.length === 0) {
            pos = size
          } else {
            const res = decodeUtf8(bytes, 0, bytes.length)
            if (res.consumed >= bytes.length) {
              segs.push({
                byteLen: res.consumed,
                charLen: res.text.length,
                diskOffset: pos,
                text: undefined,
                dirty: false,
              })
              pos += res.consumed
            } else if (res.consumed > 0) {
              // 单个字符跨读取边界：本段先收下已完整的部分，剩下的下轮再读
              segs.push({
                byteLen: res.consumed,
                charLen: res.text.length,
                diskOffset: pos,
                text: undefined,
                dirty: false,
              })
              pos += res.consumed
            } else {
              // 剩余字节不是完整的 UTF-8（文件被外部截断/损坏）。
              // 收成一个 charLen=0 的尾段，保证段表字节合计 == 文件大小，
              // 否则每次打开都会因 total !== size 重新全量扫描。
              console.warn('笔记尾部不是完整 UTF-8，按不可解码尾段处理:', uri, pos, bytes.length)
              segs.push({
                byteLen: bytes.length,
                charLen: 0,
                diskOffset: pos,
                text: '',
                dirty: false,
              })
              pos += bytes.length
            }
          }
        } catch (e) {
          pos = size
        }
        step()
      },
      fail: (data, code) => {
        if (callback) callback(new Error('scanFile fail ' + code))
      },
    })
  }
  const finish = () => {
    if (segs.length === 0) segs.push(makeSegment('', false))
    doc.segments = segs
    reindex(doc)
    writeIdx(doc, info)
    if (callback) callback(null, doc)
  }
  step()
}

// 读取单个段的文本（已加载则直接返回）。
// 顺带校验「读到的字节数 == 段表记录」与「解码消费的字节数 == 读到的字节数」，
// 不一致说明段表与实际文件错位（索引被改坏 / 旧版本写入的字节漂移），
// 此时丢弃索引，下次打开时全量重建。
function readSegText(f, doc, seg, callback) {
  if (!seg) {
    callback(null, '')
    return
  }
  if (typeof seg.text === 'string') {
    callback(null, seg.text)
    return
  }
  if (seg.byteLen <= 0) {
    callback(null, '')
    return
  }
  f.readArrayBuffer({
    uri: doc.uri,
    position: seg.diskOffset,
    length: seg.byteLen,
    success: (data) => {
      let text = ''
      try {
        const bytes = new Uint8Array(data.buffer)
        const res = decodeUtf8(bytes, 0, bytes.length)
        text = res.text
        if (seg.charLen > 0 && (bytes.length < seg.byteLen || res.consumed < bytes.length)) {
          invalidateIdx(f, doc)
        }
      } catch (e) {
        text = ''
      }
      callback(null, text)
    },
    fail: (data, code) => callback(new Error('read segment fail ' + code)),
  })
}

// 段表与文件字符边界不一致：删掉索引，让下次打开走扫描重建（自愈）
function invalidateIdx(f, doc) {
  if (!doc || doc.idxMisaligned) return
  doc.idxMisaligned = true
  console.warn('段表与笔记文件的字符边界不一致，丢弃索引以便下次重建:', doc.uri)
  if (!doc.idxUri) return
  f.delete({ uri: doc.idxUri, success: () => {}, fail: () => {} })
}

// 确保 [from, to] 段的文本已加载（从磁盘按 offset/len 读取）
export function loadRange(doc, from, to, callback) {
  if (!doc) {
    if (callback) callback(null)
    return
  }
  const n = doc.segments.length
  let lo = typeof from === 'number' ? from : 0
  let hi = typeof to === 'number' ? to : n - 1
  if (lo < 0) lo = 0
  if (hi > n - 1) hi = n - 1
  if (hi < lo) {
    if (callback) callback(null)
    return
  }
  importFile()
    .then((f) => {
      let i = lo
      // 已加载/空段用循环推进，避免大量空段时同步递归爆栈
      const step = () => {
        while (i <= hi) {
          const seg = doc.segments[i]
          if (!seg || typeof seg.text === 'string') {
            i++
            continue
          }
          if (seg.byteLen <= 0) {
            seg.text = ''
            i++
            continue
          }
          readSegText(f, doc, seg, (err, text) => {
            if (err) {
              if (callback) callback(err)
              return
            }
            seg.text = text
            i++
            step()
          })
          return
        }
        if (callback) callback(null)
      }
      step()
    })
    .catch((err) => {
      if (callback) callback(err)
    })
}

// 仅保留窗口内的段文本，逐出其他已加载的干净段
export function setWindow(doc, from, to) {
  if (!doc) return
  const n = doc.segments.length
  let lo = from
  let hi = to
  if (lo < 0) lo = 0
  if (hi > n - 1) hi = n - 1
  if (hi < lo) {
    lo = 0
    hi = 0
  }
  doc.window = { from: lo, to: hi }
  for (let i = 0; i < n; i++) {
    if (i >= lo && i <= hi) continue
    const seg = doc.segments[i]
    if (typeof seg.text === 'string' && !seg.dirty) seg.text = undefined
  }
}

// ===== 编辑 =====

function maybeSplit(doc, index) {
  const seg = doc.segments[index]
  if (!seg || typeof seg.text !== 'string') return
  if (utf8ByteLength(seg.text) <= doc.segBytes * 2) return
  const parts = splitTextByBytes(seg.text, doc.segBytes)
  const newSegs = parts.map((p) => makeSegment(p, true))
  const args = [index, 1].concat(newSegs)
  Array.prototype.splice.apply(doc.segments, args)
}

// 段边界必须落在字符边界上：若「上一段末尾是高位代理、下一段开头是低位代理」，
// 说明一个代理对被编辑切到了两段之间（各段单独编码时都会变成 U+FFFD）。
// 这里把高位代理挪到下一段开头，保证每段自身都是完整 UTF-8。
// 只对已加载的段生效（干净且未加载的段说明它没被编辑过，边界天然安全）。
function repairPairSplitAt(doc, index) {
  const segs = doc.segments
  for (let k = index - 1; k <= index; k++) {
    const a = segs[k]
    const b = segs[k + 1]
    if (!a || !b) continue
    if (typeof a.text !== 'string' || typeof b.text !== 'string') continue
    if (a.text.length === 0 || b.text.length === 0) continue
    const hi = a.text.charCodeAt(a.text.length - 1)
    const lo = b.text.charCodeAt(0)
    if (hi < 0xD800 || hi > 0xDBFF || lo < 0xDC00 || lo > 0xDFFF) continue
    const high = a.text.slice(-1)
    a.text = a.text.slice(0, -1)
    b.text = high + b.text
    a.charLen = a.text.length
    a.byteLen = utf8ByteLength(a.text)
    a.dirty = true
    b.charLen = b.text.length
    b.byteLen = utf8ByteLength(b.text)
    b.dirty = true
  }
}

// 在 pos 处插入文本（要求 pos 所在段已加载）。
// 返回插入后的光标位置（= 插入点 + str.length）；未写入时返回 -1，
// 调用方不要移动光标。插入点若正好落在代理对中间，会挪到该字符之后，
// 避免把一个 emoji 拆成两个孤立代理（保存后会变成两个 U+FFFD）。
export function insertText(doc, pos, str) {
  if (!doc) return -1
  if (typeof pos !== 'number' || pos !== pos || pos < 0) return -1
  if (!str) return pos
  const loc = locate(doc, pos)
  const seg = doc.segments[loc.index]
  if (!seg || typeof seg.text !== 'string') return -1
  let offset = loc.offset
  if (offset > 0 && offset < seg.text.length) {
    const hi = seg.text.charCodeAt(offset - 1)
    const lo = seg.text.charCodeAt(offset)
    if (hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF) offset++
  }
  const insertPos = doc.starts[loc.index] + offset
  seg.text = seg.text.slice(0, offset) + str + seg.text.slice(offset)
  seg.charLen = seg.text.length
  seg.byteLen = utf8ByteLength(seg.text)
  seg.dirty = true
  maybeSplit(doc, loc.index)
  repairPairSplitAt(doc, loc.index)
  reindex(doc)
  doc.dirty = true
  return insertPos + str.length
}

// 把 [pos, pos+len) 扩展到字符边界（端点若落在代理对中间，就把整个字符纳入）。
// 返回 { start, end }；参数非法返回 null。
function charSpan(doc, pos, len) {
  if (!doc || typeof len !== 'number' || !(len > 0)) return null
  if (typeof pos !== 'number' || pos !== pos || pos < 0) return null
  if (pos > doc.charCount) return null
  let startPos = pos
  let endPos = pos + len
  if (endPos > doc.charCount) endPos = doc.charCount
  if (endPos <= startPos) return null

  const a0 = locate(doc, startPos)
  const sa = doc.segments[a0.index]
  if (sa && typeof sa.text === 'string' && a0.offset > 0 && a0.offset < sa.text.length) {
    const hi = sa.text.charCodeAt(a0.offset - 1)
    const lo = sa.text.charCodeAt(a0.offset)
    if (hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF) startPos--
  }
  const b0 = locate(doc, endPos)
  const sb = doc.segments[b0.index]
  if (sb && typeof sb.text === 'string' && b0.offset > 0 && b0.offset < sb.text.length) {
    const hi = sb.text.charCodeAt(b0.offset - 1)
    const lo = sb.text.charCodeAt(b0.offset)
    if (hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF) endPos++
  }
  return { start: startPos, end: endPos }
}

// 执行删除 [start, end)（要求区间覆盖的段均已加载）；成功返回 true
function deleteSpan(doc, start, end) {
  const a = locate(doc, start)
  const b = locate(doc, end)
  if (a.index === b.index) {
    const seg = doc.segments[a.index]
    if (!seg || typeof seg.text !== 'string') return false
    seg.text = seg.text.slice(0, a.offset) + seg.text.slice(b.offset)
    seg.charLen = seg.text.length
    seg.byteLen = utf8ByteLength(seg.text)
    seg.dirty = true
    // 删除可能让段尾/段首出现跨段的半个字符，写盘前修好
    repairPairSplitAt(doc, a.index)
  } else {
    const first = doc.segments[a.index]
    const last = doc.segments[b.index]
    if (!first || !last || typeof first.text !== 'string' || typeof last.text !== 'string') return false
    first.text = first.text.slice(0, a.offset) + last.text.slice(b.offset)
    first.charLen = first.text.length
    first.byteLen = utf8ByteLength(first.text)
    first.dirty = true
    doc.segments.splice(a.index + 1, b.index - a.index)
    // 合并后的段可能远超上限（反复跨段退格会把整篇并成一段），必须重新切分
    maybeSplit(doc, a.index)
    // 合并点两侧可能把一个代理对劈成两段，写盘前必须修好
    repairPairSplitAt(doc, a.index)
  }
  reindex(doc)
  doc.dirty = true
  return true
}

// 删除 [pos, pos+len) 区间文本（要求区间覆盖的段均已加载）。
// 返回实际删除的 code unit 数；0 表示没有删除（段未加载/参数非法），调用方不要移动光标。
// 若区间端点落在一个代理对（emoji 等）中间，会扩展到整个字符再删，
// 避免在正文里留下孤立代理——孤立代理写盘会被编码成 U+FFFD，内容就被改写了。
export function deleteRange(doc, pos, len) {
  const span = charSpan(doc, pos, len)
  if (!span) return 0
  return deleteSpan(doc, span.start, span.end) ? span.end - span.start : 0
}

// 光标左移一位；不会停在代理对中间（emoji 等按一个字符处理）。
export function prevCharPos(doc, pos) {
  if (!doc || typeof pos !== 'number' || pos !== pos || pos <= 0) return 0
  if (pos > doc.charCount) pos = doc.charCount
  const loc = locate(doc, pos)
  const seg = doc.segments[loc.index]
  if (seg && typeof seg.text === 'string' && loc.offset >= 2) {
    const hi = seg.text.charCodeAt(loc.offset - 2)
    const lo = seg.text.charCodeAt(loc.offset - 1)
    if (hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF) return pos - 2
  }
  return pos - 1
}

// 光标右移一位；同样不会停在代理对中间。
export function nextCharPos(doc, pos) {
  if (!doc || typeof pos !== 'number' || pos !== pos) return 0
  if (pos >= doc.charCount) return doc.charCount
  const loc = locate(doc, pos)
  const seg = doc.segments[loc.index]
  if (seg && typeof seg.text === 'string' && loc.offset + 1 < seg.text.length) {
    const hi = seg.text.charCodeAt(loc.offset)
    const lo = seg.text.charCodeAt(loc.offset + 1)
    if (hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF) return pos + 2
  }
  return pos + 1
}

// 退格：删除光标前的一个字符；若光标前正好是一个代理对（emoji 等），
// 整对删除，避免留下孤立代理（落盘后会变成 U+FFFD）。
// 返回新的光标位置；删除失败时原样返回 pos（调用方据此判断失败）。
export function deleteBackward(doc, pos) {
  if (!doc || typeof pos !== 'number' || pos !== pos || pos <= 0) return pos
  const from = prevCharPos(doc, pos)
  if (from >= pos) return pos
  const span = charSpan(doc, from, pos - from)
  if (!span) return pos
  return deleteSpan(doc, span.start, span.end) ? span.start : pos
}

// ===== 全文 / 写盘 =====

// 拼回全文（仅恢复文件 / 二维码等低频场景）：干净段从磁盘读，脏段取内存
export function materialize(doc, callback) {
  if (!doc) {
    if (callback) callback(null, '')
    return
  }
  importFile()
    .then((f) => {
      const segs = doc.segments
      let i = 0
      let out = ''
      // 已加载/空段用循环推进，避免长文档同步递归爆栈
      const step = () => {
        while (i < segs.length) {
          const seg = segs[i]
          if (typeof seg.text === 'string') {
            out += seg.text
            i++
            continue
          }
          if (seg.byteLen <= 0) {
            i++
            continue
          }
          readSegText(f, doc, seg, (err, text) => {
            if (err) {
              if (callback) callback(err)
              return
            }
            out += text
            i++
            step()
          })
          return
        }
        if (callback) callback(null, out)
      }
      step()
    })
    .catch((err) => {
      if (callback) callback(err)
    })
}

// 流式写整篇到 uri：脏段取内存，干净段从旧文件按 offset 读回。
// 目标与 doc.uri 相同时先把旧文件复制到临时文件，避免边写边读。
export function writeDocToUri(doc, uri, callback) {
  if (!doc) {
    if (callback) callback(null)
    return
  }
  importFile()
    .then((f) => {
      const segs = doc.segments
      const needsSource = segs.some((s) => typeof s.text !== 'string')
      const inPlace = uri === doc.uri
      let source = null
      let tmp = null

      // 成功后丢弃备份
      const dropTmp = () => {
        if (!tmp) return
        const t = tmp
        tmp = null
        f.delete({ uri: t, success: () => {}, fail: () => {} })
      }

      // 失败时目标文件可能已被写坏：先用 .bak 复原再回调错误。
      // 复原失败则保留 .bak（不再删除），保证总有完整副本可人工/下次启动恢复。
      const abort = (err) => {
        if (!tmp) {
          if (callback) callback(err)
          return
        }
        const t = tmp
        f.copy({
          srcUri: t,
          dstUri: uri,
          success: () => {
            tmp = null
            f.delete({ uri: t, success: () => {}, fail: () => {} })
            if (callback) callback(err)
          },
          fail: () => {
            console.error('保存失败且无法从备份恢复，已保留备份文件:', t)
            if (callback) callback(err)
          },
        })
      }

      const start = (src) => {
        source = src
        let i = 0
        const next = (err) => {
          if (err) {
            abort(err)
            return
          }
          if (i >= segs.length) {
            dropTmp()
            if (callback) callback(null)
            return
          }
          const seg = segs[i]
          const piece = i
          const writePiece = (text) => {
            f.writeText({
              uri: uri,
              text: typeof text === 'string' ? text : '',
              append: piece > 0,
              success: () => {
                i++
                next(null)
              },
              fail: (data, code) => next(new Error('writeDoc fail ' + code)),
            })
          }
          if (typeof seg.text === 'string') {
            writePiece(seg.text)
            return
          }
          if (seg.byteLen <= 0) {
            writePiece('')
            return
          }
          if (!source) {
            next(new Error('writeDoc missing source'))
            return
          }
          f.readArrayBuffer({
            uri: source,
            position: seg.diskOffset,
            length: seg.byteLen,
            success: (data) => {
              let text = ''
              try {
                const bytes = new Uint8Array(data.buffer)
                text = decodeUtf8(bytes, 0, bytes.length).text
              } catch (e) {}
              writePiece(text)
            },
            fail: (data, code) => next(new Error('writeDoc read source fail ' + code)),
          })
        }
        next(null)
      }

      if (!needsSource) {
        start(null)
        return
      }
      if (!inPlace) {
        start(doc.uri)
        return
      }
      // 原地保存：复制旧文件后从副本读取干净段。
      // 复制失败必须零写入退出——否则先截断目标、再因缺少 source 报错，文件就毁了。
      tmp = uri + '.bak'
      const t = tmp
      f.copy({
        srcUri: doc.uri,
        dstUri: t,
        success: () => start(t),
        fail: (data, code) => {
          tmp = null
          if (callback) callback(new Error('writeDoc backup fail ' + code))
        },
      })
    })
    .catch((err) => {
      if (callback) callback(err)
    })
}

// 保存成功后提交：重算段在磁盘上的偏移、清除脏标记、逐出窗口外段、写 idx
export function commitDoc(doc, info, callback) {
  if (!doc) {
    if (callback) callback(null)
    return
  }
  let off = 0
  for (let i = 0; i < doc.segments.length; i++) {
    const seg = doc.segments[i]
    seg.diskOffset = off
    off += seg.byteLen
    seg.dirty = false
  }
  reindex(doc)
  setWindow(doc, doc.window.from, doc.window.to)
  writeIdx(doc, info)
  if (callback) callback(null)
}

// 兼容旧接口名（逐段写盘），内部改走流式写整篇
export function writeChunks(uri, chunks, callback) {
  importFile()
    .then((f) => {
      const arr = chunks && chunks.length ? chunks : ['']
      let i = 0
      const next = () => {
        if (i >= arr.length) {
          if (callback) callback(null)
          return
        }
        f.writeText({
          uri: uri,
          text: arr[i],
          append: i > 0,
          success: () => {
            i++
            next()
          },
          fail: (data, code) => {
            if (callback) callback(new Error('writeChunks fail ' + code))
          },
        })
      }
      next()
    })
    .catch((err) => {
      if (callback) callback(err)
    })
}
