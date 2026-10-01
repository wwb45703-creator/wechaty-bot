/**
 * 微信机器人控制台 —— preload 桥接层
 *
 * 通过 contextBridge 向渲染层暴露 window.botctl，全部为 ipcRenderer.invoke 的薄封装。
 * 渲染层不接触 Node/Electron API（contextIsolation: true，nodeIntegration: false）。
 *
 * 用法示例：
 *   const s = await window.botctl.getStatus();
 *   const off = window.botctl.onStatus((status) => console.log(status)); // 订阅推送
 *   off(); // 取消订阅
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('botctl', {
  // 获取一次当前状态快照（与 'status' 推送的结构相同）
  getStatus: (...args) => ipcRenderer.invoke('getStatus', ...args),

  // 启动 bot → {ok:true, pid} | {ok:false, error}
  startBot: (...args) => ipcRenderer.invoke('startBot', ...args),

  // 停止 bot（写停用标记 + 精确杀进程）→ {ok:true} | {ok:false, error}
  stopBot: (...args) => ipcRenderer.invoke('stopBot', ...args),

  // 列出 Ollama 模型 → {ok:true, models:[{name,size}]} | {ok:false, error}
  getModels: (...args) => ipcRenderer.invoke('getModels', ...args),

  // 切换当前模型（bot 运行中会自动重启生效）→ {ok:true, restarted} | {ok:false, error}
  setCurrentModel: (...args) => ipcRenderer.invoke('setCurrentModel', ...args),

  // 导入 gguf 模型 {name, path} → {ok:bool, log:'ollama create 输出'}（耗时可达 10 分钟）
  importModel: (...args) => ipcRenderer.invoke('importModel', ...args),

  // 读取 bot 日志尾部（lines 默认 30）→ {ok:true, lines:['...']} | {ok:false, error}
  getLogs: (...args) => ipcRenderer.invoke('getLogs', ...args),

  // 启动 Ollama 服务（幂等）→ {ok:true, alreadyRunning} | {ok:false, error}
  startOllama: (...args) => ipcRenderer.invoke('startOllama', ...args),

  // 弹文件选择框选 .gguf → 选中路径字符串 | null（取消）；对话框异常时 {ok:false, error}
  pickGgufFile: (...args) => ipcRenderer.invoke('pickGgufFile', ...args),

  /**
   * 订阅主进程每 3 秒推送的状态（通道 'status'）。
   * 返回取消订阅函数，组件销毁时记得调用。
   */
  onStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('status', handler);
    return () => ipcRenderer.removeListener('status', handler);
  },
});
