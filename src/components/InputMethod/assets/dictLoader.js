/**
 * 词库运行时加载器
 *
 * 词库不再内联进页面 .jsc，而是作为 txt(JSON) 资源随包分发，按需通过
 * @system.file.readText 读取（由 tools/gen-dictionary.js 生成）。
 *
 * 目的：把约 140KB 词库从页面字节码里移出去，避免部分机型（小米手环 11 等）
 * 上输入法组件模块加载失败、只显示空白容器的问题；同时按首字母分片，
 * 每次输入通常只加载 1 个分片，降低常驻内存。
 *
 * 读取是异步的：调用方先用 getShard()/getBaseDictionary() 同步取缓存，
 * 取不到时调 loadShard()/loadBaseDictionary() 触发加载，加载完成后由
 * setDictionaryReadyCallback 注册的回调通知界面重算候选。
 */

const DICT_DIR = '/components/InputMethod/assets/dictionary/'

let onReady = null

// 注册词库就绪回调（单字表或任一分片加载完成时触发，用于重算候选）
function setDictionaryReadyCallback(cb) {
  onReady = cb
}

function notify() {
  if (typeof onReady === 'function') {
    try {
      onReady()
    } catch (e) {
      console.warn('InputMethod dictionary ready callback failed:', e)
    }
  }
}

// ===== @system.file 懒加载 =====
// 用动态 import，避免输入法组件初始化阶段就拉入文件模块。
let fileApi = null
let fileLoading = false
const fileWaiters = []

function withFile(cb) {
  if (fileApi) {
    cb(fileApi)
    return
  }
  fileWaiters.push(cb)
  if (fileLoading) return
  fileLoading = true
  import('@system.file')
    .then((mod) => {
      fileApi = mod.default || mod
      fileLoading = false
      const list = fileWaiters.splice(0, fileWaiters.length)
      for (let i = 0; i < list.length; i++) {
        try {
          list[i](fileApi)
        } catch (e) {
          console.warn('InputMethod dictionary load failed:', e)
        }
      }
    })
    .catch((err) => {
      fileLoading = false
      fileWaiters.length = 0
      console.warn('InputMethod dictionary load failed: @system.file unavailable', err)
      notify()
    })
}

// 读取并解析资源目录下的 JSON 文本。
// 资源路径优先用绝对路径（/components/...），部分固件只认相对路径，失败后回退再试一次。
function readJson(api, name, ok, fail) {
  const uris = [DICT_DIR + name, DICT_DIR.slice(1) + name]
  let attempt = 0
  let done = false

  const finish = (obj, err) => {
    if (done) return
    done = true
    if (obj) ok(obj)
    else fail(err)
  }

  const read = () => {
    try {
      api.readText({
        uri: uris[attempt],
        success(res) {
          let obj = null
          try {
            obj = JSON.parse((res && res.text) || '')
          } catch (e) {
            obj = null
          }
          if (!obj && attempt + 1 < uris.length) {
            attempt++
            read()
            return
          }
          finish(obj, 'parse')
        },
        fail(data, code) {
          if (attempt + 1 < uris.length) {
            attempt++
            read()
            return
          }
          finish(null, code || 'io')
        },
      })
    } catch (e) {
      if (attempt + 1 < uris.length) {
        attempt++
        read()
        return
      }
      finish(null, 'exception')
    }
  }

  read()
}

// ===== 单字表 cn.txt（常驻） =====
let base = null
let baseState = 'idle' // idle | loading | loaded | failed
let baseWaiters = []

function getBaseDictionary() {
  return base
}

function loadBaseDictionary(cb) {
  if (base) {
    if (cb) cb(base)
    return
  }
  if (baseState === 'failed') {
    if (cb) cb(null)
    return
  }
  if (cb) baseWaiters.push(cb)
  if (baseState === 'loading') return
  baseState = 'loading'
  withFile((api) => {
    readJson(api, 'cn.txt', (obj) => {
      base = obj
      baseState = 'loaded'
      const waiters = baseWaiters
      baseWaiters = []
      for (let i = 0; i < waiters.length; i++) {
        try { waiters[i](base) } catch (e) {}
      }
      notify()
    }, (err) => {
      baseState = 'failed'
      console.warn('InputMethod dictionary load failed: cn.txt', err)
      const waiters = baseWaiters
      baseWaiters = []
      for (let i = 0; i < waiters.length; i++) {
        try { waiters[i](null) } catch (e) {}
      }
      notify()
    })
  })
}

// ===== 整词分片 words-x.txt（按需加载，键盘隐藏时释放） =====
const shards = {}
const shardState = {} // idle | loading | loaded | failed

function getShard(letter) {
  if (!letter) return null
  return shards[letter] || null
}

function loadShard(letter, cb) {
  if (!letter || letter.length !== 1) return
  const ch = letter.charAt(0)
  if (shards[ch]) {
    if (cb) cb(shards[ch])
    return
  }
  // 失败的分片本次会话不再重试，避免每次按键都重复 I/O
  if (shardState[ch] === 'failed') return
  if (shardState[ch] === 'loading') return
  shardState[ch] = 'loading'
  withFile((api) => {
    readJson(api, 'words-' + ch + '.txt', (obj) => {
      obj.keys = Object.keys(obj.words || {})
      shards[ch] = obj
      shardState[ch] = 'loaded'
      if (cb) cb(obj)
      notify()
    }, (err) => {
      shardState[ch] = 'failed'
      console.warn('InputMethod dictionary load failed: words-' + ch + '.txt', err)
      notify()
    })
  })
}

// 释放整词分片（单字表保留，键盘每次弹出都要用）
function releaseShards() {
  for (const ch in shards) delete shards[ch]
  for (const ch in shardState) {
    if (shardState[ch] === 'loaded' || shardState[ch] === 'failed') delete shardState[ch]
  }
}

export {
  setDictionaryReadyCallback,
  getBaseDictionary,
  loadBaseDictionary,
  getShard,
  loadShard,
  releaseShards,
}
