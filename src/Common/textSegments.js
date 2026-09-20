// 文本分段模块：把笔记内容按 UTF-8 字节切成若干段（chunk），
// 只为渲染窗口、相邻段翻转与逐段写盘服务。
// 说明：笔记文件由 writeText 写成 UTF-8；本模块手写 UTF-8 编解码，
// 避免依赖平台不保证存在的 TextDecoder。

const DEFAULT_SEG_BYTES = 128

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

// 把整段文本按 UTF-8 字节数切块，保证不切断代理对
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

function buildStarts(doc) {
  const starts = new Array(doc.chunks.length + 1)
  starts[0] = 0
  for (let i = 0; i < doc.chunks.length; i++) {
    starts[i + 1] = starts[i] + doc.chunks[i].length
  }
  doc.starts = starts
}

// 创建空文档对象（不读盘）
export function makeDoc(segBytes, uri) {
  const doc = {
    uri: uri || '',
    segBytes: segBytes || DEFAULT_SEG_BYTES,
    chunks: [''],
    starts: [0, 0],
    charCount: 0,
    dirty: false,
  }
  return doc
}

// 由已有全文创建文档（恢复笔记 / 兼容旧传参）
export function createDocFromText(text, segBytes) {
  const doc = makeDoc(segBytes)
  const src = text || ''
  doc.chunks = splitTextByBytes(src, doc.segBytes)
  doc.charCount = src.length
  buildStarts(doc)
  return doc
}

// 定位绝对字符位置 -> { index, offset }
export function locate(doc, pos) {
  const starts = doc.starts
  const n = doc.chunks.length
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

// 取 [a, b) 区间的文本
export function getRange(doc, a, b) {
  if (!doc || b <= a) return ''
  const sa = locate(doc, a)
  const sb = locate(doc, b)
  if (sa.index === sb.index) {
    return doc.chunks[sa.index].slice(sa.offset, sb.offset)
  }
  let out = doc.chunks[sa.index].slice(sa.offset)
  for (let i = sa.index + 1; i < sb.index; i++) {
    out += doc.chunks[i]
  }
  out += doc.chunks[sb.index].slice(0, sb.offset)
  return out
}

function maybeSplit(doc, index) {
  const ch = doc.chunks[index]
  if (utf8ByteLength(ch) <= doc.segBytes * 2) return
  const parts = splitTextByBytes(ch, doc.segBytes)
  const args = [index, 1].concat(parts)
  Array.prototype.splice.apply(doc.chunks, args)
}

// 在 pos 处插入文本
export function insertText(doc, pos, str) {
  if (!doc || !str) return doc
  const loc = locate(doc, pos)
  const ch = doc.chunks[loc.index]
  doc.chunks[loc.index] = ch.slice(0, loc.offset) + str + ch.slice(loc.offset)
  doc.charCount += str.length
  doc.dirty = true
  maybeSplit(doc, loc.index)
  buildStarts(doc)
  return doc
}

// 删除 [pos, pos+len) 区间文本
export function deleteRange(doc, pos, len) {
  if (!doc || len <= 0) return doc
  const endPos = pos + len
  const a = locate(doc, pos)
  const b = locate(doc, endPos)
  if (a.index === b.index) {
    const ch = doc.chunks[a.index]
    doc.chunks[a.index] = ch.slice(0, a.offset) + ch.slice(b.offset)
  } else {
    doc.chunks[a.index] = doc.chunks[a.index].slice(0, a.offset) + doc.chunks[b.index].slice(b.offset)
    doc.chunks.splice(a.index + 1, b.index - a.index)
  }
  doc.charCount -= len
  if (doc.charCount < 0) doc.charCount = 0
  doc.dirty = true
  buildStarts(doc)
  return doc
}

// 拼回全文（仅恢复文件 / 二维码等低频场景）
export function materialize(doc) {
  if (!doc) return ''
  return doc.chunks.join('')
}

// ===== 文件读写 =====

// 逐段写文件：首段覆盖，其余 append，避免保存时拼出整串
export function writeChunks(uri, chunks, callback) {
  import('@system.file')
    .then((file) => {
      const f = file.default || file
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

// 从磁盘按字节分段读取并解码成文档
export function loadDocFromFile(uri, segBytes, callback) {
  const limit = segBytes || DEFAULT_SEG_BYTES
  import('@system.file')
    .then((file) => {
      const f = file.default || file
      f.get({
        uri: uri,
        success: (info) => {
          const size = (info && info.length) || 0
          const doc = makeDoc(limit, uri)
          if (size <= 0) {
            if (callback) callback(null, doc)
            return
          }
          readAll(f, uri, size, limit, doc, callback)
        },
        fail: () => {
          // 文件不存在：返回空文档
          const doc = makeDoc(limit, uri)
          if (callback) callback(null, doc)
        },
      })
    })
    .catch((err) => {
      if (callback) callback(err)
    })
}

function readAll(f, uri, size, segBytes, doc, callback) {
  let pos = 0
  const chunks = []
  const step = () => {
    if (pos >= size) {
      if (chunks.length === 0) chunks.push('')
      doc.chunks = chunks
      doc.charCount = 0
      for (let i = 0; i < chunks.length; i++) doc.charCount += chunks[i].length
      buildStarts(doc)
      if (callback) callback(null, doc)
      return
    }
    const want = Math.min(segBytes + 4, size - pos)
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
              // 防止死循环：没有任何完整字符时强行前进 1 字节
              pos += 1
            } else {
              chunks.push(res.text)
              pos += res.consumed
            }
          }
        } catch (e) {
          pos = size
        }
        step()
      },
      fail: (data, code) => {
        if (callback) callback(new Error('loadDocFromFile read fail ' + code))
      },
    })
  }
  step()
}
