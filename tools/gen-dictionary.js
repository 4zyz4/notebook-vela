/**
 * 词库资源生成脚本
 *
 * 把 tools/dictionary-source 下的旧版 JS 词库，转换成 InputMethod 组件运行时
 * 通过 @system.file 读取的 txt(JSON) 资源：
 *   src/components/InputMethod/assets/dictionary/cn.txt        单字表
 *   src/components/InputMethod/assets/dictionary/words-x.txt   按拼音首字母分片的整词表
 *
 * 为什么要外置：词库（约 140KB）内联进页面 .jsc 后，部分机型（如小米手环 11）
 * 上输入法组件会加载失败、只显示空白容器。外置后页面 .jsc 只剩逻辑代码，
 * 词库按需异步读取。
 *
 * 用法：node tools/gen-dictionary.js
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'tools', 'dictionary-source')
const SYLLABLES = path.join(ROOT, 'src', 'components', 'InputMethod', 'assets', 'pinyin_syllables.js')
const OUT = path.join(ROOT, 'src', 'components', 'InputMethod', 'assets', 'dictionary')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dicgen-'))

// 把 ES module 末尾的 export 换成 CommonJS 导出，再 require 执行
function loadModule(file, exportName) {
  const src = fs.readFileSync(file, 'utf8')
  const body = src.replace(/export\s*\{[^}]*\}\s*;?\s*$/, `module.exports = { ${exportName} }`)
  const dst = path.join(TMP, path.basename(file).replace(/\.js$/, '.cjs'))
  fs.writeFileSync(dst, body, 'utf8')
  delete require.cache[dst]
  return require(dst)[exportName]
}

const chars = loadModule(path.join(SRC, 'dic.js'), 'getDict')()
const words = loadModule(path.join(SRC, 'dic_words.js'), 'getWords')()
const initialsIndex = loadModule(path.join(SRC, 'dic_words_initials.js'), 'getInitialsIndex')()
const syllables = loadModule(SYLLABLES, 'syllables')

console.log('单字音节数:', Object.keys(chars).length)
console.log('整词数:', Object.keys(words).length)
console.log('简拼索引数:', Object.keys(initialsIndex).length)
console.log('合法音节数:', syllables.length)

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })

// cn.txt：单字表 + 合法音节表（与上游词库格式保持一致）
fs.writeFileSync(path.join(OUT, 'cn.txt'), JSON.stringify({ chars, syllables }), 'utf8')

// 按词键首字母分片：同一首字母的整词、简拼、前向索引都落在同一分片，
// 因此查询任意拼音串只需加载其首字母对应的那一个分片。
const shards = {}
for (const key of Object.keys(words)) {
  const ch = key[0]
  if (!/^[a-z]$/.test(ch)) throw new Error('词键首字母异常: ' + key)
  if (!shards[ch]) shards[ch] = []
  shards[ch].push(key)
}

let total = 0
for (const ch of Object.keys(shards).sort()) {
  const keys = shards[ch]
  const index = {}
  keys.forEach((k, i) => { index[k] = i })

  const shardWords = {}
  keys.forEach((k) => { shardWords[k] = words[k] })

  // 简拼索引：首字母串 -> 词键序号数组（存序号而非字符串，减小体积与内存）
  const initials = {}
  for (const abbr of Object.keys(initialsIndex)) {
    if (abbr[0] !== ch) continue
    const list = []
    for (const k of initialsIndex[abbr]) {
      const i = index[k]
      if (i === undefined) throw new Error('简拼索引引用了不存在的词: ' + k)
      list.push(i)
    }
    initials[abbr] = list
  }

  // 前向索引：拼音前 2 字母 -> 词键序号数组
  const forward = {}
  keys.forEach((k, i) => {
    if (k.length < 2) return
    const pref = k.slice(0, 2)
    if (!forward[pref]) forward[pref] = []
    forward[pref].push(i)
  })

  const json = JSON.stringify({ words: shardWords, initials, forward })
  fs.writeFileSync(path.join(OUT, 'words-' + ch + '.txt'), json, 'utf8')
  total += Buffer.byteLength(json)
  console.log(ch, '词数=' + keys.length, '字节=' + Buffer.byteLength(json))
}
console.log('整词分片总字节:', total)
