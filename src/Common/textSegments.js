// 文本分段模块：笔记内容按 UTF-8 字节切成若干段（segment）。
// 真正的分段：段文本不常驻内存，渲染时按需从磁盘读取当前窗口内的段，
// 编辑只加载受影响的段，保存时流式重写（脏段取内存、干净段从旧文件读回）。
// 段表（每段字节数/字符数）记在 note_<id>.txt.idx，打开时 O(1)；
// 若索引缺失或失效，则扫描一遍文件重建段表（只记元数据、不驻留文本）。
//
// 文件仍是纯 UTF-8 文本，保证 index 预览、互连读整篇、二维码等旧路径不受影响。

const DEFAULT_SEG_BYTES = 128

// ===== UTF-8 基础 =====

// 计算字符串的 UTF-8 字节数
export function utf8ByteLength(str) {
  let len = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c < 0x80) {
      len += 1
    } else if (c < 0x800) {
      len += 2
    } else if (c >= 0xD800 && c <= 0xDBFF) {
      len += 4
      i++
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
  const limit = segBytes || DEFAULT_SEG_BYTES
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
      cb = 4
      step = 2
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
    segBytes: segBytes || DEFAULT_SEG_BYTES,
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
  if (pos < 0) pos = 0
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
      f.writeText({ uri: doc.idxUri, text: payload, success: () => {}, fail: () => {} })
    })
    .catch(() => {})
}

// 打开笔记：优先读 idx 建段表，否则扫描文件重建
export function openDoc(uri, segBytes, callback) {
  const limit = segBytes || DEFAULT_SEG_BYTES
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
        fail: () => {
          // 文件不存在：空文档
          if (callback) callback(null, makeDoc(limit, uri))
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
    if (!data || data.segBytes !== segBytes) return null
    if (!Array.isArray(data.segs) || data.segs.length === 0) return null
    // 文件被外部改动（大小相同但 mtime 变了）时判定失效
    if (mtime && data.mtime && data.mtime !== mtime) return null
    let total = 0
    const segs = []
    for (let i = 0; i < data.segs.length; i++) {
      const pair = data.segs[i]
      if (!pair || typeof pair[0] !== 'number' || typeof pair[1] !== 'number') return null
      segs.push({ byteLen: pair[0], charLen: pair[1], diskOffset: total, text: undefined, dirty: false })
      total += pair[0]
    }
    if (total !== size) return null
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
            if (res.consumed <= 0) {
              pos += 1
            } else {
              segs.push({
                byteLen: res.consumed,
                charLen: res.text.length,
                diskOffset: pos,
                text: undefined,
                dirty: false,
              })
              pos += res.consumed
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
      const next = (err) => {
        if (err) {
          if (callback) callback(err)
          return
        }
        while (i <= hi && isLoaded(doc, i)) i++
        if (i > hi) {
          if (callback) callback(null)
          return
        }
        const seg = doc.segments[i]
        if (seg.byteLen <= 0) {
          seg.text = ''
          i++
          next(null)
          return
        }
        f.readArrayBuffer({
          uri: doc.uri,
          position: seg.diskOffset,
          length: seg.byteLen,
          success: (data) => {
            try {
              const bytes = new Uint8Array(data.buffer)
              seg.text = decodeUtf8(bytes, 0, bytes.length).text
            } catch (e) {
              seg.text = ''
            }
            i++
            next(null)
          },
          fail: (data, code) => next(new Error('loadRange fail ' + code)),
        })
      }
      next(null)
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

// 在 pos 处插入文本（要求 pos 所在段已加载）
export function insertText(doc, pos, str) {
  if (!doc || !str) return doc
  const loc = locate(doc, pos)
  const seg = doc.segments[loc.index]
  if (!seg || typeof seg.text !== 'string') return doc
  seg.text = seg.text.slice(0, loc.offset) + str + seg.text.slice(loc.offset)
  seg.charLen = seg.text.length
  seg.byteLen = utf8ByteLength(seg.text)
  seg.dirty = true
  maybeSplit(doc, loc.index)
  reindex(doc)
  doc.dirty = true
  return doc
}

// 删除 [pos, pos+len) 区间文本（要求区间覆盖的段均已加载）
export function deleteRange(doc, pos, len) {
  if (!doc || len <= 0) return doc
  const endPos = pos + len
  const a = locate(doc, pos)
  const b = locate(doc, endPos)
  if (a.index === b.index) {
    const seg = doc.segments[a.index]
    if (!seg || typeof seg.text !== 'string') return doc
    seg.text = seg.text.slice(0, a.offset) + seg.text.slice(b.offset)
    seg.charLen = seg.text.length
    seg.byteLen = utf8ByteLength(seg.text)
    seg.dirty = true
  } else {
    const first = doc.segments[a.index]
    const last = doc.segments[b.index]
    if (!first || !last || typeof first.text !== 'string' || typeof last.text !== 'string') return doc
    first.text = first.text.slice(0, a.offset) + last.text.slice(b.offset)
    first.charLen = first.text.length
    first.byteLen = utf8ByteLength(first.text)
    first.dirty = true
    doc.segments.splice(a.index + 1, b.index - a.index)
  }
  reindex(doc)
  doc.dirty = true
  return doc
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
      const next = (err) => {
        if (err) {
          if (callback) callback(err)
          return
        }
        if (i >= segs.length) {
          if (callback) callback(null, out)
          return
        }
        const seg = segs[i]
        if (typeof seg.text === 'string') {
          out += seg.text
          i++
          next(null)
          return
        }
        if (seg.byteLen <= 0) {
          i++
          next(null)
          return
        }
        f.readArrayBuffer({
          uri: doc.uri,
          position: seg.diskOffset,
          length: seg.byteLen,
          success: (data) => {
            try {
              const bytes = new Uint8Array(data.buffer)
              out += decodeUtf8(bytes, 0, bytes.length).text
            } catch (e) {}
            i++
            next(null)
          },
          fail: (data, code) => next(new Error('materialize fail ' + code)),
        })
      }
      next(null)
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

      const cleanup = (after) => {
        if (!tmp) {
          after()
          return
        }
        const t = tmp
        tmp = null
        f.delete({ uri: t, success: () => after(), fail: () => after() })
      }

      const start = (src) => {
        source = src
        let i = 0
        const next = (err) => {
          if (err) {
            cleanup(() => callback && callback(err))
            return
          }
          if (i >= segs.length) {
            cleanup(() => callback && callback(null))
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
      // 原地保存：复制旧文件后从副本读取干净段
      tmp = uri + '.bak'
      const t = tmp
      f.copy({
        srcUri: doc.uri,
        dstUri: t,
        success: () => start(t),
        fail: () => {
          tmp = null
          start(null)
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
