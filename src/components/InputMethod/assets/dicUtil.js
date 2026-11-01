import { syllables } from './pinyin_syllables.js'
import {
  setDictionaryReadyCallback,
  loadBaseDictionary,
  getShard,
  loadShard,
  releaseShards,
} from './dictLoader.js'

const excludedShuangpinSyllables = new Set(['n', 'm', 'ng', 'hm', 'hng'])

function values(value) {
  return Array.isArray(value) ? value : [value]
}

function splitPinyinSyllable(syllable) {
  if (/^[aoe]/.test(syllable)) return ['', syllable]
  for (const initial of ['zh', 'ch', 'sh']) {
    if (syllable.indexOf(initial) === 0) {
      return [initial, syllable.slice(initial.length)]
    }
  }
  return [syllable[0], syllable.slice(1)]
}

function getRawOffset(boundaries, pinyinOffset) {
  for (const boundary of boundaries) {
    if (pinyinOffset <= boundary.pinyinOffset) return boundary.rawOffset
  }
  return boundaries.length > 0 ? boundaries[boundaries.length - 1].rawOffset : 0
}

// 辅助：从词库取值（支持单值和数组），去重推入 wordHits
function pushWordHits(val, arr) {
  if (!val) return
  if (Array.isArray(val)) {
    for (var i = 0; i < val.length; i++) {
      if (val[i] && arr.indexOf(val[i]) === -1) arr.push(val[i])
    }
  } else if (arr.indexOf(val) === -1) {
    arr.push(val)
  }
}

let SimpleInputMethod = {
  dict: {}
}

SimpleInputMethod.buildShuangpinIndex = function(schema) {
  const index = Object.create(null)

  for (const syllable of syllables) {
    if (excludedShuangpinSyllables.has(syllable)) continue
    const parts = splitPinyinSyllable(syllable)
    const initial = parts[0]
    const final = parts[1]

    if (!initial) {
      for (const code of Object.keys(schema.rest)) {
        if (schema.rest[code] === syllable) index[code] = syllable
      }
      continue
    }

    const initialKeys = Object.keys(schema.first).filter((key) => schema.first[key] === initial)
    const finalKeys = Object.keys(schema.second).filter((key) => values(schema.second[key]).indexOf(final) !== -1)
    for (const initialKey of initialKeys) {
      for (const finalKey of finalKeys) {
        index[initialKey + finalKey] = syllable
      }
    }
  }

  return index
}

SimpleInputMethod.decodeShuangpin = function(rawCode, index) {
  const decodedSyllables = []
  const boundaries = []
  let rawOffset = 0
  let pinyinOffset = 0

  while (rawOffset + 1 < rawCode.length) {
    const syllable = index[rawCode.slice(rawOffset, rawOffset + 2)]
    if (!syllable) break
    decodedSyllables.push(syllable)
    rawOffset += 2
    pinyinOffset += syllable.length
    boundaries.push({ pinyinOffset, rawOffset })
  }

  const pinyin = decodedSyllables.join('')
  const rest = rawCode.slice(rawOffset)
  const decodedDisplay = decodedSyllables.join("'")
  const display = decodedDisplay && rest ? `${decodedDisplay}'${rest}` : decodedDisplay + rest

  return {
    pinyin,
    display,
    rawConsumed: rawOffset,
    boundaries,
    rest,
  }
}

SimpleInputMethod.getShuangpinHanzi = function(rawCode, index) {
  const decoded = this.decodeShuangpin(rawCode, index)
  if (!decoded.pinyin) {
    return { chars: [], matched: '', multi: null, decoded }
  }

  const result = this.getHanzi(decoded.pinyin, 'cn')
  const matchedRawOffset = getRawOffset(decoded.boundaries, result.matched.length)
  if (result.multi && result.multi.sylTopChars) {
    result.multi.sylTopChars = result.multi.sylTopChars.map((item) => ({
      char: item.char,
      offset: getRawOffset(decoded.boundaries, item.offset),
    }))
  }

  return {
    chars: result.chars,
    matched: rawCode.slice(0, matchedRawOffset),
    multi: result.multi,
    decoded,
  }
}

// 取某个拼音键对应的词条（字符串或数组）。分片未加载时触发异步加载并返回 null。
SimpleInputMethod._wordOf = function(key) {
  if (!key) return null
  const shard = this._shardOf(key.charAt(0))
  if (!shard) return null
  return shard.words[key] || null
}

// 取首字母分片：已加载直接返回，否则触发加载并返回 null（加载完成后由回调重算）
SimpleInputMethod._shardOf = function(letter) {
  if (!letter) return null
  const shard = getShard(letter)
  if (shard) return shard
  loadShard(letter)
  return null
}

SimpleInputMethod._notifyReady = function() {
  const cb = this.onDictionaryReady
  if (typeof cb === 'function') {
    try {
      cb()
    } catch (e) {
      console.warn('InputMethod dictionary ready callback failed:', e)
    }
  }
}

SimpleInputMethod.initDict = function() {
  // 幂等：已初始化则跳过（组件可能多次挂载）
  if (this.dict.inited) return
  this.dict.inited = true

  // 合法音节集合先由内置音节表建立（同步可用，供分词显示/双拼索引使用）
  this.dict.syllableSet = new Set(syllables)
  this.dict.py2hz = {}
  this.dict.py2hz2 = {}
  this.dict.py2hz2['i'] = 'i' // 特殊处理
  this.dict.baseReady = false

  // 单字表异步加载：期间键盘照常渲染，只是暂无候选；加载完成后回调界面重算。
  loadBaseDictionary((base) => {
    if (!base || !base.chars) return
    const chars = base.chars
    for (let key in chars) {
      this.dict.py2hz[key] = chars[key]
      const ch = key.charAt(0)
      if (!this.dict.py2hz2[ch]) this.dict.py2hz2[ch] = chars[key]
      this.dict.syllableSet.add(key)
    }
    const fileSyllables = base.syllables
    if (fileSyllables) {
      for (let i = 0; i < fileSyllables.length; i++) this.dict.syllableSet.add(fileSyllables[i])
    }
    this.dict.baseReady = true
  })

  // 词库就绪回调：加载器每完成一个分片都会通知，界面据此重算候选
  setDictionaryReadyCallback(() => {
    this._notifyReady()
  })
}

// 释放整词分片（单字表常驻）。键盘隐藏时调用，降低常驻内存。
SimpleInputMethod.releaseWords = function() {
  releaseShards()
  if (typeof global !== 'undefined' && global && typeof global.runGC === 'function') {
    global.runGC()
  }
}

SimpleInputMethod.getSingleHanzi = function(pinyin, lang = 'cn') {
  // 仅中文查询候选，en 模式不查候选
  if (lang !== 'cn') return ''
  return this.dict.py2hz2[pinyin]
  || this.dict.py2hz[pinyin]
  || ''
}

// 取音节首字：单字表 py2hz 优先，词库单音节兜底。
// 部分音节（如 shei）只在词库里（"shei":"谁"），单字表无对应键，
// 若不兜底会丢逐字候选（如 shishei 缺「谁」），且整词组合也因此失败。
SimpleInputMethod._sylTopChar = function(syl) {
  const c = this.dict.py2hz[syl] || ''
  if (c) return c[0]
  const w = this._wordOf(syl)
  if (w) {
    const f = Array.isArray(w) ? w[0] : w
    return f ? f[0] : ''
  }
  return ''
}

// 把连续拼音串切成合法音节数组。
// 返回 { segs, rest, pos } 其中 pos[i] 为 segs[0..i] 在原串中的累计长度
// 若整段全合法且仅 1 个音节，返回 null（单字流程）。
SimpleInputMethod.segmentPinyin = function(pinyin) {
  if (!pinyin) return null
  const set = this.dict.syllableSet
  const result = []
  const pos = []
  let i = 0
  const maxLen = 24
  while (i < pinyin.length && i < maxLen) {
    let matched = ''
    for (let len = Math.min(6, pinyin.length - i); len >= 1; len--) {
      const s = pinyin.substr(i, len)
      if (set.has(s)) { matched = s; break }
    }
    if (!matched) break
    result.push(matched)
    i += matched.length
    pos.push(i)
  }
  let rest = pinyin.substr(i)
  // 末段若是叹词单字音，且前面有 ≥2 音节 → 视为不完整前缀移到 rest
  const DUMMY_ENDING = { m: 1, n: 1, ng: 1, hm: 1, hng: 1 }
  if (!rest && result.length >= 2) {
    const lastSeg = result[result.length - 1]
    if (DUMMY_ENDING[lastSeg]) {
      rest = result.pop()
      pos.pop()
    }
  }
  if (!rest && result.length === 1) return null
  if (result.length === 0) return null
  return { segs: result, rest: rest, pos: pos }
}

// 将不完整音节前缀补全为最可能的完整音节：
// 1) 优先选能和 prevSyl 拼成词库词的音节
// 2) 常用字母前缀映射兜底
// 3) 再不行取字母序第一个
SimpleInputMethod.completeSyllable = function(prefix, prevSyl) {
  if (!prefix) return ''
  const COMMON = {
    'z': 'zai', 'm': 'ma', 'b': 'bu', 'd': 'de', 'g': 'ge',
    'h': 'he', 'j': 'ji', 'k': 'ke', 'l': 'le', 'n': 'ne',
    'q': 'qi', 'r': 'ren', 's': 'shi', 't': 'ta', 'w': 'wo',
    'x': 'xi', 'y': 'yi',
    'zh': 'zhe', 'ch': 'chi', 'sh': 'shi',
    'p': 'ping', 'f': 'fa', 'c': 'ci', 'a': 'ai', 'o': 'ou',
  }
  const set = this.dict.syllableSet
  const candidates = []
  for (const syl of set) {
    if (syl.indexOf(prefix) === 0 && syl.length > prefix.length) {
      candidates.push(syl)
    }
  }
  if (candidates.length === 0) return ''
  // 优先：能和前一个音节拼成词库词的
  if (prevSyl) {
    for (const c of candidates) {
      if (this._wordOf(prevSyl + c)) return c
    }
  }
  // 常用补全映射
  if (COMMON[prefix]) return COMMON[prefix]
  // 字母序第一个
  return candidates[0]
}

// 对分词结果做尾随拼接修复：若末段是单字音尝试与 rest 拼合。
// 拼合后成合法音节 → 替换末段；否则去掉末段占位。
SimpleInputMethod.tryStitchTrailing = function(segResult) {
  if (!segResult || !segResult.rest) return segResult
  const { segs, rest, pos } = segResult
  if (!rest) return segResult
  const last = segs[segs.length - 1]
  if (last.length > 2) return segResult
  const combined = last + rest
  if (this.dict.syllableSet.has(combined)) {
    const newSegs = segs.slice(0, -1).concat([combined])
    const newPos = pos.slice()
    newPos[newPos.length - 1] = (newPos[newPos.length - 1] || 0) + rest.length
    return { segs: newSegs, rest: '', pos: newPos }
  }
  if (last.length <= 2) {
    const cleanSegs = segs.slice(0, -1)
    const cleanPos = pos.slice(0, -1)
    if (cleanSegs.length >= 2) {
      return { segs: cleanSegs, rest: '', pos: cleanPos }
    }
  }
  return segResult
}

// 混合匹配：全拼音节 + 简拼首字母混合输入（如 nbi→牛逼, niub→牛逼）
// 从简拼倒排索引反向展开简拼部分命中词，过滤词音节数与 token 数不一质的。
// 简拼首字母串的首字母与整词拼音首字母相同，因此只需当前首字母分片。
SimpleInputMethod.matchMixedWords = function(pinyin) {
  if (!pinyin) return null
  const set = this.dict.syllableSet
  // 贪心切分：完整音节优先，否则单字母当作简拼
  const tokens = []
  const offsets = []
  let i = 0
  while (i < pinyin.length) {
    let matched = ''
    for (let len = Math.min(6, pinyin.length - i); len >= 1; len--) {
      const s = pinyin.substr(i, len)
      if (set.has(s)) { matched = s; break }
    }
    if (matched) { tokens.push(matched); i += matched.length }
    else { tokens.push(pinyin[i]); i += 1 }
    offsets.push(i)
  }
  if (tokens.length < 2) return null

  // 收集简拼 token 对应的首字母
  let mixedAbbr = ''
  for (var ti = 0; ti < tokens.length; ti++) mixedAbbr += tokens[ti][0]

  const shard = this._shardOf(mixedAbbr.charAt(0))
  if (!shard) return null
  const matchedKeys = shard.initials[mixedAbbr] || []
  if (matchedKeys.length === 0) return null

  const hits = []
  for (var ki = 0; ki < matchedKeys.length && hits.length < 8; ki++) {
    const key = shard.keys[matchedKeys[ki]]
    // 按需切分候选词（混合输入命中候选极少）
    const keySegs = this.segmentPinyin(key)
    if (!keySegs || !keySegs.segs || keySegs.segs.length !== tokens.length) continue
    var syls = keySegs.segs
    var ok = true
    for (var j = 0; j < tokens.length; j++) {
      var t = tokens[j]
      var s = syls[j]
      if (t.length > 1) {
        if (t !== s) { ok = false; break }
      } else if (t !== s[0]) {
        ok = false; break
      }
    }
    if (ok) hits.push({ key: key, syls: syls, offsets: offsets })
  }
  return hits.length > 0 ? hits : null
}

// 生成拼音分词显示串：如 "nihao" → "ni'hao"，"nb" → "n'b"，"niub" → "niu'b"
// 全拼输入：segmentPinyin 贪心切分
// 纯简拼/混合：单字母视为独立音节
SimpleInputMethod.getSegmentedDisplay = function(pinyin) {
  if (!pinyin) return ''
  if (!this.dict.syllableSet) return pinyin
  var len = pinyin.length
  // 快速路径：单音节或非音节 → 原样
  if (len === 1 || this.dict.syllableSet.has(pinyin)) return pinyin

  // 贪心切分（从 segmentPinyin 内联以节省函数调用）
  const set = this.dict.syllableSet
  const tokens = []
  let ii = 0
  while (ii < len) {
    let mtch = ''
    for (let l = Math.min(6, len - ii); l >= 1; l--) {
      if (set.has(pinyin.substr(ii, l))) { mtch = pinyin.substr(ii, l); break }
    }
    if (mtch) { tokens.push(mtch); ii += mtch.length }
    else { tokens.push(pinyin[ii]); ii += 1 }
  }
  if (tokens.length >= 2) return tokens.join("'")
  return pinyin
}

// 多拼查字：词库优先，未命中再分词逐字组合。返回 { words, composed, segs }
SimpleInputMethod.getMultiHanzi = function(pinyin, lang = 'cn') {
  const empty = { words: [], composed: '', segs: null }
  if (lang !== 'cn') return empty
  if (!this.dict.baseReady) return empty
  // 触发首字母分片加载：整词/简拼/前向索引都在同一分片里。
  // 分片尚未就绪时下面各步都会落空，加载完成后由就绪回调重算候选。
  this._shardOf(pinyin.charAt(0))

  const wordHits = []
  var matchSource = '' // 'exact','prefix','forward','initials','composed'

  // 1) 词库整串精确命中
  const exact = this._wordOf(pinyin)
  if (exact) { pushWordHits(exact, wordHits); matchSource = 'exact' }
  // 输入进行中：前缀命中（如输入到 nihaox 时命中 nihao）
  if (wordHits.length === 0) {
    const max = Math.min(pinyin.length, 12)
    for (let len = max; len >= 2; len--) {
      const head = pinyin.substr(0, len)
      const hit = this._wordOf(head)
      if (hit) { pushWordHits(hit, wordHits); matchSource = 'prefix'; break }
    }
  }
  // 前向前缀匹配（首2字母索引，避免全表遍历；限流前6条防止海量候选）
  if (wordHits.length === 0 && pinyin.length >= 2 && !this.dict.syllableSet.has(pinyin)) {
    const pref = pinyin.substr(0, 2)
    const shard = this._shardOf(pref.charAt(0))
    const candidates = (shard && shard.forward[pref]) || []
    let fwdCount = 0
    for (let ki = 0; ki < candidates.length && fwdCount < 6; ki++) {
      const key = shard.keys[candidates[ki]]
      if (key.indexOf(pinyin) === 0) {
        pushWordHits(shard.words[key], wordHits); matchSource = 'forward'
        fwdCount++
      }
    }
  }
  // 首字母简拼匹配（限流前6条）
  if (wordHits.length === 0 && pinyin.length >= 2 && pinyin.length <= 8 && !this.dict.syllableSet.has(pinyin)) {
    const shard = this._shardOf(pinyin.charAt(0))
    const list = (shard && shard.initials[pinyin]) || []
    for (let k = 0; k < list.length && k < 6; k++) {
      const key = shard.keys[list[k]]
      pushWordHits(shard.words[key], wordHits); matchSource = 'initials'
    }
  }

  // 混合匹配：全拼音节与简拼首字母混合（如 nbi → 牛逼，niub → 牛逼）
  var mixedInfo = null
  if (wordHits.length === 0 && pinyin.length >= 2 && pinyin.length <= 8 && !this.dict.syllableSet.has(pinyin)) {
    const mixed = this.matchMixedWords(pinyin)
    if (mixed && mixed.length > 0) {
      for (let mi = 0; mi < mixed.length; mi++) {
        pushWordHits(this._wordOf(mixed[mi].key), wordHits)
      }
      matchSource = 'mixed'
      mixedInfo = mixed[0]
    }
  }

  // 2) 分词逐字组合候选（贪心查词库长词 + 尾部不完整音节补全）
  const rawSeg = this.segmentPinyin(pinyin)
  const segResult = rawSeg ? this.tryStitchTrailing(rawSeg) : null
  let segs = segResult ? segResult.segs : null
  let pos = segResult ? segResult.pos : null
  const rest = segResult ? segResult.rest : ''
  // 滤掉无字叹词单音，pos 同步删对应索引
  if (segs) {
    const DUMMY = { m: 1, n: 1, ng: 1, hm: 1, hng: 1 }
    const keep = []
    const keepPos = []
    for (let j = 0; j < segs.length; j++) {
      if (DUMMY[segs[j]]) {
        if ((this.dict.py2hz[segs[j]] || '')[0]) { keep.push(segs[j]); keepPos.push(pos[j]) }
      } else {
        keep.push(segs[j]); keepPos.push(pos[j])
      }
    }
    segs = keep.length > 0 ? keep : segs
    pos = keep.length > 0 ? keepPos : pos
  }
  // 每音节的首字 + 对应在原拼音中的累计偏移（供逐字递进选择用）
  let sylTopChars = []
  if (segs) {
    for (let j = 0; j < segs.length; j++) {
      const ch = this._sylTopChar(segs[j])
      if (ch) {
        sylTopChars.push({ char: ch, offset: pos[j] })
      }
    }
  }
  // 补全尾部不完整前缀（如 "z"→"zai", "m"→"ma"）追加到 segs 末尾
  if (segs && rest) {
    const prevSyl = segs.length >= 1 ? segs[segs.length - 1] : ''
    const completed = this.completeSyllable(rest, prevSyl)
    if (completed) {
      segs = segs.concat([completed])
      const rawOffset = (pos.length > 0 ? pos[pos.length - 1] : 0) + completed.length
      const lastOffset = Math.min(rawOffset, pinyin.length)  // 补全偏移不能超过输入长度
      const ch = this._sylTopChar(completed)
      if (ch) sylTopChars.push({ char: ch, offset: lastOffset })
    }
  }
  let composed = ''
  if (segs) {
    const result = []
    let i = 0
    while (i < segs.length) {
      let matched = false
      for (let len = Math.min(4, segs.length - i); len >= 2; len--) {
        const key = segs.slice(i, i + len).join('')
        const hit = this._wordOf(key)
        if (hit) {
          // 同音词数组取首个（最常见）
          result.push(Array.isArray(hit) ? hit[0] : hit)
          i += len
          matched = true
          break
        }
      }
      if (!matched) {
        const ch = this._sylTopChar(segs[i])
        result.push(ch)
        i++
      }
    }
    composed = result.join('')
    if (composed.length !== segs.length) composed = ''
  }

  // 整词去重保序
  const wout = []
  for (const w of wordHits) {
    if (w && wout.indexOf(w) === -1) wout.push(w)
  }

  // 非全拼模式（简拼命中）：用词中字位偏移替代 音节拆分偏移
  // 注意：仅当真正走 initials 简拼路径时才成立（每字对应一个首字母，偏移 = 字位 + 1）。
  // 单音节整串命中（segs 为 null，如词库的 "shei":"谁"）不能走这里——否则偏移被算成 1，
  // 点选候选只消费 1 个字母导致残留（如点"谁"剩"hei"）；此时候选对应整串音节，偏移应为输入全长。
  if (matchSource === 'initials' && pinyin.length >= 2) {
    const abbrChars = []
    for (var wi = 0; wi < wout.length && abbrChars.length < 12; wi++) {
      var word = wout[wi]
      for (var ci = 0; ci < word.length && abbrChars.length < 12; ci++) {
        var ch = word[ci]
        var offset = ci + 1  // 简拼每字对应一个首字母，偏移 = 字位 + 1
        var found = false
        for (var ai = 0; ai < abbrChars.length; ai++) {
          if (abbrChars[ai].char === ch && abbrChars[ai].offset === offset) { found = true; break }
        }
        if (!found) abbrChars.push({ char: ch, offset: offset })
      }
    }
    if (abbrChars.length > 0) sylTopChars = abbrChars
  } else if (!segs && wout.length > 0) {
    // 单音节整串命中（segs=null，如 "shei":"谁"）：候选整词对应整串输入，
    // 逐字候选 offset = 输入全长，点选一次消费整个音节，不残留。
    const fullChars = []
    for (var fi = 0; fi < wout.length && fullChars.length < 8; fi++) {
      const fch = wout[fi].charAt(0) || ''
      let fdup = false
      for (let di = 0; di < fullChars.length; di++) {
        if (fullChars[di].char === fch) { fdup = true; break }
      }
      if (fch && !fdup) fullChars.push({ char: fch, offset: pinyin.length })
    }
    if (fullChars.length > 0) sylTopChars = fullChars
  }

  // 混合模式：用命中词的真实音节首字 + 输入偏移覆盖 sylTopChars
  if (matchSource === 'mixed' && mixedInfo && mixedInfo.syls) {
    var miSyls = mixedInfo.syls
    var mchars = []
    for (var mj = 0; mj < miSyls.length; mj++) {
      var mch = this._sylTopChar(miSyls[mj])
      if (mch) mchars.push({ char: mch, offset: mixedInfo.offsets[mj] })
    }
    if (mchars.length > 0) sylTopChars = mchars
  }

  return { words: wout, composed: composed, segs: segs, sylTopChars: sylTopChars }
}

SimpleInputMethod.getHanzi = function(pinyin, lang = 'cn') {
  // 未初始化/单字表未加载守卫（异步加载，期间返回空，键盘照常渲染）
  if (!this.dict.baseReady) return { chars: [], matched: '', multi: null }
  // 原单字逻辑（首音节同音字串）
  let chars = []
  let matched = ''
  let result = this.getSingleHanzi(pinyin, lang)
  if (result) {
    chars = result.split('')
    matched = pinyin
  } else {
    let max = Math.min(pinyin.length, 6)
    for (let len = max; len >= 1; len--) {
      let head = pinyin.substr(0, len)
      let rs = this.getSingleHanzi(head, lang)
      if (rs) {
        chars = rs.split('')
        matched = head
        break
      }
    }
  }

  // 多拼候选（仅 cn）
  let multi = null
  if (lang === 'cn') {
    multi = this.getMultiHanzi(pinyin, lang)
  }

  return { chars, matched, multi }
}

// 注意：initDict 不再于模块加载时同步执行。
// 由 InputMethod.ux 在 onInit 中调用，词库文本由 dictLoader 异步读取，
// 加载完成前键盘正常渲染、暂无候选。
export { SimpleInputMethod }
