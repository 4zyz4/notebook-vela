import { decodeUtf8, createDocFromText, writeDocToUri, commitDoc, DEFAULT_SEG_BYTES } from './textSegments.js'

// 全局设置监听器
let settingsListeners = [];

// 笔记变化监听器
let notesListeners = [];

// 跨页面共享的设置缓存。
// Vela 的 global 对象在所有页面间共享，因此 index 页读到的设置，
// edit 页在 onInit 阶段就能同步拿到并在首次渲染前应用，避免先用默认值渲染一帧。
// 设置只会通过 saveSettings 修改（保存成功时同步更新缓存），所以缓存始终与文件一致。
const SETTINGS_CACHE_KEY = '__notebookSettingsCache';

function readSettingsCache() {
  try {
    if (typeof global !== 'undefined' && global[SETTINGS_CACHE_KEY]) {
      return global[SETTINGS_CACHE_KEY];
    }
  } catch (e) {
    // global 不可用时按无缓存处理
  }
  return null;
}

function writeSettingsCache(settings) {
  try {
    if (typeof global !== 'undefined') {
      global[SETTINGS_CACHE_KEY] = settings;
    }
  } catch (e) {
    // 缓存失败不影响正常读写设置
  }
}

// 同步获取已缓存的设置；没有缓存时返回 null，由调用方决定是否异步读取
export function getCachedSettingsSync() {
  return readSettingsCache();
}

// 首次读盘尚未返回时，后续调用排队等待，避免同一页面重复读同一个文件
let settingsLoading = false;
let settingsWaiters = [];

// 读取设置：已缓存时同步回调，否则异步读盘（并发调用会合并为一次读取）
export function getCachedSettings(callback) {
  if (typeof callback !== 'function') {
    console.error('getCachedSettings: callback必须是一个函数');
    return;
  }

  const cached = readSettingsCache();
  if (cached) {
    callback(null, cached);
    return;
  }

  settingsWaiters.push(callback);
  if (settingsLoading) return;
  settingsLoading = true;

  const finish = (err, settings) => {
    // 只在读取成功时缓存：失败可能只是暂时性的，下次调用重新读盘
    if (!err && settings) {
      writeSettingsCache(settings);
    }
    settingsLoading = false;
    // 先取走队列，回调中再次调用 getCachedSettings 不会重复入队
    const waiters = settingsWaiters;
    settingsWaiters = [];
    waiters.forEach((fn) => {
      try {
        fn(err, settings);
      } catch (e) {
        console.error('设置读取回调执行出错:', e);
      }
    });
  };

  import('@system.file').then(file => {
    if (!file || !file.default) {
      console.error('无法导入文件系统模块');
      finish(new Error('Failed to import file system module'), getDefaultSettings());
      return;
    }

    file.default.readText({
      uri: 'internal://files/settings.json',
      success: (result) => {
        try {
          if (result && result.text) {
            const settings = JSON.parse(result.text);
            finish(null, settings);
          } else {
            console.log('设置文件为空，使用默认设置');
            finish(null, getDefaultSettings());
          }
        } catch (e) {
          console.log('解析设置失败', e);
          finish(e, getDefaultSettings());
        }
      },
      fail: (data, code) => {
        if (code === 404) {
          // 设置文件还不存在（尚未改过设置）：默认值就是当前真实设置，
          // 按成功处理并缓存，避免每次进页面都读盘、都闪一次“加载中”
          console.log('设置文件不存在，使用默认设置');
          finish(null, getDefaultSettings());
          return;
        }
        console.log('读取设置文件失败', code);
        finish(new Error(`Failed to read settings: ${code}`), getDefaultSettings());
      }
    });
  }).catch(err => {
    console.error('导入文件系统模块时出错:', err);
    finish(err, getDefaultSettings());
  });
}

// 获取默认设置
function getDefaultSettings() {
  return {
    vibrationEnabled: true,
    timeDisplayType: 'createTime',
    autoScrollType: 'oneBlank',
    borderWidth: '10px',
    keyboardLayout: 'QWERTY'
  };
}

// 保存设置
export function saveSettings(settings, callback) {
  if (!settings) {
    console.error('saveSettings: settings参数不能为空');
    if (callback && typeof callback === 'function') {
      callback(new Error('Settings cannot be null or undefined'));
    }
    return;
  }

  if (callback && typeof callback !== 'function') {
    console.error('saveSettings: callback必须是一个函数');
    return;
  }

  import('@system.file').then(file => {
    if (!file || !file.default) {
      console.error('无法导入文件系统模块');
      if (callback) callback(new Error('Failed to import file system module'));
      return;
    }

    file.default.writeText({
      uri: 'internal://files/settings.json',
      text: JSON.stringify(settings),
      success: () => {
        console.log('设置保存成功');
        // 写入成功后再更新缓存，保证缓存与文件内容一致
        writeSettingsCache(settings);
        notifySettingsChange(settings);
        if (callback) callback(null);
      },
      fail: (data, code) => {
        console.error('设置保存失败', code, data);
        if (callback) callback(new Error(`Failed to save settings: ${code}`));
      }
    });
  }).catch(err => {
    console.error('导入文件系统模块时出错:', err);
    if (callback) callback(err);
  });
}

// 清除设置缓存：下次读取会重新读盘
export function clearSettingsCache() {
  writeSettingsCache(null);
}

// 添加设置变化监听器
export function addSettingsListener(listener) {
  if (typeof listener === 'function') {
    settingsListeners.push(listener);
  }
}

// 移除设置变化监听器
export function removeSettingsListener(listener) {
  const index = settingsListeners.indexOf(listener);
  if (index !== -1) {
    settingsListeners.splice(index, 1);
  }
}

// 通知设置变化
function notifySettingsChange(settings) {
  settingsListeners.forEach(listener => {
    try {
      listener(settings);
    } catch (e) {
      console.error('设置监听器执行出错:', e);
    }
  });
}

// 添加笔记变化监听器
export function addNotesListener(listener) {
  if (typeof listener === 'function') {
    notesListeners.push(listener);
  }
}

// 移除笔记变化监听器
export function removeNotesListener(listener) {
  const index = notesListeners.indexOf(listener);
  if (index !== -1) {
    notesListeners.splice(index, 1);
  }
}

// 通知笔记变化
export function notifyNotesChange() {
  // 通知所有监听器
  notesListeners.forEach(listener => {
    try {
      listener();
    } catch (e) {
      console.error('笔记监听器执行出错:', e);
    }
  });
}

// 保存单个笔记文件。
// 注意：这里必须走分段写入，不能再使用 writeText 整篇覆盖。
// 整篇 writeText 会让 note_<id>.txt.idx 与实际内容错位，编辑器下次打开
// 虽然能靠大小/时间校验发现，但会退化为全量扫描；分片上传也依赖 idx。
export function saveNoteFile(noteId, content, callback) {
  import('@system.file').then(file => {
    if (!file || !file.default) {
      console.error('无法导入文件系统模块');
      if (callback) callback(new Error('Failed to import file system module'));
      return;
    }

    const f = file.default;
    const uri = `internal://files/note_${noteId}.txt`;
    const staging = uri + '.save';
    const doc = createDocFromText(content || '', DEFAULT_SEG_BYTES, uri);

    // 先写 staging，再复制到目标：整篇覆盖失败时不会破坏原笔记。
    writeDocToUri(doc, staging, (writeErr) => {
      if (writeErr) {
        f.delete({ uri: staging, success: () => {}, fail: () => {} });
        console.error(`保存笔记文件失败: ${writeErr.message || writeErr}`);
        if (callback) callback(writeErr);
        return;
      }
      f.copy({
        srcUri: staging,
        dstUri: uri,
        success: () => {
          f.delete({ uri: staging, success: () => {}, fail: () => {} });
          f.get({
            uri: uri,
            success: (info) => {
              commitDoc(doc, info, () => {
                console.log(`笔记文件 note_${noteId}.txt 保存成功（分段写入）`);
                if (callback) callback(null);
              });
            },
            fail: () => {
              commitDoc(doc, null, () => {
                console.log(`笔记文件 note_${noteId}.txt 保存成功（分段写入，无文件信息）`);
                if (callback) callback(null);
              });
            }
          });
        },
        fail: (data, code) => {
          f.delete({ uri: staging, success: () => {}, fail: () => {} });
          console.error(`保存笔记文件失败: copy ${code}`, data);
          if (callback) callback(new Error(`Failed to save note file: ${code}`));
        }
      });
    });
  }).catch(err => {
    console.error('导入文件系统模块时出错:', err);
    if (callback) callback(err);
  });
}

// 读取单个笔记文件
export function readNoteFile(noteId, callback) {
  import('@system.file').then(file => {
    if (!file || !file.default) {
      console.error('无法导入文件系统模块');
      if (callback) callback(new Error('Failed to import file system module'));
      return;
    }

    file.default.readText({
      uri: `internal://files/note_${noteId}.txt`,
      success: (result) => {
        if (callback) callback(null, result.text);
      },
      fail: (data, code) => {
        console.log(`读取笔记文件失败: ${code}`, data);
        if (callback) callback(new Error(`Failed to read note file: ${code}`));
      }
    });
  }).catch(err => {
    console.error('导入文件系统模块时出错:', err);
    if (callback) callback(err);
  });
}

// 只读取笔记文件头部若干字节（用于列表预览，避免为预览读入整篇）
export function readNoteFileHead(noteId, maxBytes, callback) {
  import('@system.file').then(file => {
    if (!file || !file.default) {
      console.error('无法导入文件系统模块');
      if (callback) callback(new Error('Failed to import file system module'));
      return;
    }

    const uri = `internal://files/note_${noteId}.txt`;
    const readHead = (size) => {
      const length = Math.max(1, Math.min(maxBytes, size));
      file.default.readArrayBuffer({
        uri: uri,
        position: 0,
        length: length,
        success: (data) => {
          try {
            const bytes = new Uint8Array(data.buffer);
            const text = decodeUtf8(bytes, 0, bytes.length).text;
            if (callback) callback(null, text);
          } catch (e) {
            if (callback) callback(e);
          }
        },
        fail: (data, code) => {
          console.log(`读取笔记头部失败: ${code}`, data);
          if (callback) callback(new Error(`Failed to read note head: ${code}`));
        }
      });
    };

    file.default.get({
      uri: uri,
      success: (info) => readHead((info && info.length) || 0),
      // 取不到大小时按请求长度尝试
      fail: () => readHead(maxBytes)
    });
  }).catch(err => {
    console.error('导入文件系统模块时出错:', err);
    if (callback) callback(err);
  });
}

// 删除单个笔记文件
export function deleteNoteFile(noteId, callback) {
  import('@system.file').then(file => {
    if (!file || !file.default) {
      console.error('无法导入文件系统模块');
      if (callback) callback(new Error('Failed to import file system module'));
      return;
    }

    file.default.delete({
      uri: `internal://files/note_${noteId}.txt`,
      success: () => {
        console.log(`笔记文件 note_${noteId}.txt 删除成功`);
        // 顺带清理分段索引文件（不存在则忽略）
        file.default.delete({ uri: `internal://files/note_${noteId}.txt.idx`, success: () => {}, fail: () => {} });
        if (callback) callback(null);
      },
      fail: (data, code) => {
        console.error(`删除笔记文件失败: ${code}`, data);
        if (callback) callback(new Error(`Failed to delete note file: ${code}`));
      }
    });
  }).catch(err => {
    console.error('导入文件系统模块时出错:', err);
    if (callback) callback(err);
  });
}

// 保存元数据文件
export function saveMetadata(metadata, callback) {
  import('@system.file').then(file => {
    if (!file || !file.default) {
      console.error('无法导入文件系统模块');
      if (callback) callback(new Error('Failed to import file system module'));
      return;
    }

    file.default.writeText({
      uri: 'internal://files/metadata.json',
      text: JSON.stringify(metadata),
      success: () => {
        console.log('元数据文件保存成功');
        if (callback) callback(null);
      },
      fail: (data, code) => {
        console.error(`保存元数据文件失败: ${code}`, data);
        if (callback) callback(new Error(`Failed to save metadata: ${code}`));
      }
    });
  }).catch(err => {
    console.error('导入文件系统模块时出错:', err);
    if (callback) callback(err);
  });
}

// 读取元数据文件
export function readMetadata(callback) {
  import('@system.file').then(file => {
    if (!file || !file.default) {
      console.error('无法导入文件系统模块');
      if (callback) callback(new Error('Failed to import file system module'));
      return;
    }

    file.default.readText({
      uri: 'internal://files/metadata.json',
      success: (result) => {
        try {
          const metadata = JSON.parse(result.text);
          if (callback) callback(null, metadata);
        } catch (e) {
          console.error('解析元数据失败', e);
          if (callback) callback(e);
        }
      },
      fail: (data, code) => {
        console.log(`读取元数据文件失败: ${code}`, data);
        // 如果元数据文件不存在，返回空的元数据对象而不是错误
        if (code === 404) { // 文件不存在
          if (callback) callback(null, { notes: {} });
        } else {
          if (callback) callback(new Error(`Failed to read metadata: ${code}`));
        }
      }
    });
  }).catch(err => {
    console.error('导入文件系统模块时出错:', err);
    if (callback) callback(err);
  });
}

// 保存恢复笔记到recovery.txt
export function saveRecoveryFile(content, callback) {
  import('@system.file').then(file => {
    if (!file || !file.default) {
      console.error('无法导入文件系统模块');
      if (callback) callback(new Error('Failed to import file system module'));
      return;
    }

    file.default.writeText({
      uri: 'internal://files/recovery.txt',
      text: content,
      success: () => {
        console.log('恢复笔记文件 recovery.txt 保存成功');
        if (callback) callback(null);
      },
      fail: (data, code) => {
        console.error(`保存恢复笔记文件失败: ${code}`, data);
        if (callback) callback(new Error(`Failed to save recovery file: ${code}`));
      }
    });
  }).catch(err => {
    console.error('导入文件系统模块时出错:', err);
    if (callback) callback(err);
  });
}

// 读取恢复笔记文件
export function readRecoveryFile(callback) {
  import('@system.file').then(file => {
    if (!file || !file.default) {
      console.error('无法导入文件系统模块');
      if (callback) callback(new Error('Failed to import file system module'));
      return;
    }

    file.default.readText({
      uri: 'internal://files/recovery.txt',
      success: (result) => {
        if (callback) callback(null, result.text);
      },
      fail: (data, code) => {
        console.log(`读取恢复笔记文件失败: ${code}`, data);
        if (callback) callback(new Error(`Failed to read recovery file: ${code}`));
      }
    });
  }).catch(err => {
    console.error('导入文件系统模块时出错:', err);
    if (callback) callback(err);
  });
}

// 清除恢复笔记文件：优先真正删除；文件不存在或删除失败时退化为写空内容，确保不再被识别为恢复笔记
export function clearRecoveryFile(callback) {
  import('@system.file').then(file => {
    if (!file || !file.default) {
      console.error('无法导入文件系统模块');
      if (callback) callback(new Error('Failed to import file system module'));
      return;
    }

    // 删除失败（如文件不存在）时写空内容兜底
    const blankOut = () => {
      file.default.writeText({
        uri: 'internal://files/recovery.txt',
        text: '',
        success: () => {
          console.log('恢复笔记文件 recovery.txt 已清空');
          if (callback) callback(null);
        },
        fail: (data, code) => {
          console.error(`清空恢复笔记文件失败: ${code}`, data);
          if (callback) callback(new Error(`Failed to clear recovery file: ${code}`));
        }
      });
    };

    // 删除后回读确认：某些情况下删除回调成功但文件仍可读到内容，
    // 此时写空兜底，确保 index 不会再把它识别为恢复笔记
    const verifyCleared = () => {
      file.default.readText({
        uri: 'internal://files/recovery.txt',
        success: (result) => {
          if (result && typeof result.text === 'string' && result.text.trim() !== '') {
            console.log('恢复笔记文件删除后仍有内容，改为清空');
            blankOut();
          } else {
            console.log('恢复笔记文件 recovery.txt 删除成功');
            if (callback) callback(null);
          }
        },
        fail: () => {
          // 读不到说明文件已不存在，视为清除成功
          console.log('恢复笔记文件 recovery.txt 删除成功');
          if (callback) callback(null);
        }
      });
    };

    file.default.delete({
      uri: 'internal://files/recovery.txt',
      success: verifyCleared,
      fail: (data, code) => {
        // 文件本就不存在或删除失败：退化为清空
        console.log(`删除恢复笔记文件失败，改为清空: ${code}`, data);
        blankOut();
      }
    });
  }).catch(err => {
    console.error('导入文件系统模块时出错:', err);
    if (callback) callback(err);
  });
}
