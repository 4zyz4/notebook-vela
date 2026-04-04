// 全局设置缓存
let settingsCache = null;
let settingsCacheTime = 0;
// 设置变化监听器
let settingsListeners = [];

// 笔记变化监听器
let notesListeners = [];

// 读取设置文件，带缓存机制
export function getCachedSettings(callback) {
  // 参数检查
  if (typeof callback !== 'function') {
    console.error('getCachedSettings: callback必须是一个函数');
    return;
  }
  
  const now = Date.now();
  
  // 如果缓存存在
  if (settingsCache) {
    callback(null, settingsCache);
    return;
  }
  
  // 异步导入文件系统模块
  import('@system.file').then(file => {
    // 检查file模块是否存在
    if (!file || !file.default) {
      console.error('无法导入文件系统模块');
      // 使用默认设置并缓存
      settingsCache = getDefaultSettings();
      settingsCacheTime = now;
      callback(new Error('Failed to import file system module'), settingsCache);
      return;
    }
    
    file.default.readText({
          uri: 'internal://files/settings.json',
          success: (result) => {
            try {
          // 检查结果是否存在且有文本内容
              if (result && result.text) {
                const settings = JSON.parse(result.text);
            // 更新缓存
                settingsCache = settings;
                settingsCacheTime = now;
                callback(null, settings);
              } else {
            // 文件存在但内容为空，使用默认设置
                console.log('设置文件为空，使用默认设置');
            settingsCache = getDefaultSettings();
                settingsCacheTime = now;
            callback(null, settingsCache);
              }
        } catch (e) {
          console.log('解析设置失败', e);
          // 使用默认设置并缓存
          settingsCache = getDefaultSettings();
              settingsCacheTime = now;
          callback(e, settingsCache);
            }
          },
          fail: (data, code) => {
        console.log('读取设置文件失败', code);
        // 使用默认设置并缓存
        settingsCache = getDefaultSettings();
        settingsCacheTime = now;
        callback(new Error(`Failed to read settings: ${code}`), settingsCache);
      }
    });
  }).catch(err => {
    console.error('导入文件系统模块时出错:', err);
    // 使用默认设置并缓存
    settingsCache = getDefaultSettings();
    settingsCacheTime = Date.now();
    callback(err, settingsCache);
  });
}

// 获取默认设置
function getDefaultSettings() {
  return {
    vibrationEnabled: true,
    timeDisplayType: 'createTime',
    autoScrollType: 'oneBlank',
    borderWidth: '10px'
  };
}

// 保存设置
export function saveSettings(settings, callback) {
  // 参数检查
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
  
  try {
    import('@system.file').then(file => {
      // 检查file模块是否存在
      if (!file || !file.default) {
        console.error('无法导入文件系统模块');
        if (callback) callback(new Error('Failed to import file system module'));
        return;
      }
      
          try {
            file.default.writeText({
              uri: 'internal://files/settings.json',
              text: JSON.stringify(settings),
              success: () => {
                console.log('设置保存成功');
                // 更新缓存
                settingsCache = settings;
                // 设置缓存时间为最大安全整数，确保缓存永不过期
                settingsCacheTime = Number.MAX_SAFE_INTEGER;
                // 通知所有监听器设置已更改
                notifySettingsChange(settings);
                if (callback) callback(null);
              },
              fail: (data, code) => {
                console.error('设置保存失败', code, data);
                if (callback) callback(new Error(`Failed to save settings: ${code}`));
              }
            });
          } catch (e) {
            console.error('调用文件写入接口时出错:', e);
            if (callback) callback(e);
          }
    }).catch(err => {
      console.error('导入文件系统模块时出错:', err);
      if (callback) callback(err);
    });
  } catch (e) {
    console.error('saveSettings函数执行时出错:', e);
    if (callback) callback(e);
  }
}

// 清除设置缓存
export function clearSettingsCache() {
  settingsCache = null;
  settingsCacheTime = 0;
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
  // 通知所有监听器
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

// 保存单个笔记文件
export function saveNoteFile(noteId, content, callback) {
  import('@system.file').then(file => {
    if (!file || !file.default) {
      console.error('无法导入文件系统模块');
      if (callback) callback(new Error('Failed to import file system module'));
      return;
    }

    file.default.writeText({
      uri: `internal://files/note_${noteId}.txt`,
      text: content,
      success: () => {
        console.log(`笔记文件 note_${noteId}.txt 保存成功`);
        if (callback) callback(null);
      },
      fail: (data, code) => {
        console.error(`保存笔记文件失败: ${code}`, data);
        if (callback) callback(new Error(`Failed to save note file: ${code}`));
      }
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

// 清除恢复笔记文件
export function clearRecoveryFile(callback) {
  import('@system.file').then(file => {
    if (!file || !file.default) {
      console.error('无法导入文件系统模块');
      if (callback) callback(new Error('Failed to import file system module'));
      return;
    }

    file.default.writeText({
      uri: 'internal://files/recovery.txt',
      text: '',
      success: () => {
        console.log('恢复笔记文件 recovery.txt 清除成功');
        if (callback) callback(null);
      },
      fail: (data, code) => {
        console.error(`清除恢复笔记文件失败: ${code}`, data);
        if (callback) callback(new Error(`Failed to clear recovery file: ${code}`));
      }
    });
  }).catch(err => {
    console.error('导入文件系统模块时出错:', err);
    if (callback) callback(err);
  });
}
