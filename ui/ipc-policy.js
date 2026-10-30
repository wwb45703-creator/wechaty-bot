const { pathToFileURL } = require('node:url');

const ALLOWED_CHANNELS = new Set([
  'getStatus', 'startBot', 'stopBot', 'getModels', 'setCurrentModel', 'getLoadedModels', 'loadModel', 'unloadModel', 'importModel', 'getLogs', 'startOllama', 'stopOllama', 'testChat', 'getAutostart', 'setAutostart', 'listMemories', 'deleteMemory', 'getMemoryDetail', 'getPersonaState', 'getEmotionState', 'getPersonaHistory', 'listRelationships', 'getRelationship', 'deleteRelationship', 'pickGgufFile',
  'astrbot:status', 'astrbot:plugins:list', 'astrbot:plugins:market', 'astrbot:plugins:toggle', 'astrbot:plugins:install', 'astrbot:kb:list', 'astrbot:kb:query', 'astrbot:service:toggle',
  'skills:list', 'skills:detail', 'skills:propose', 'skills:evaluate', 'skills:activate', 'skills:reject', 'skills:rollback', 'skills:deactivate', 'social:list', 'social:detail', 'social:forget',
]);
function trustedSender(event, windows, rendererPath) {
  if (!event?.sender || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  if (!windows.some((w) => !w.isDestroyed() && w.webContents === event.sender)) return false;
  return String(event.senderFrame.url || '').split('#')[0] === pathToFileURL(rendererPath).href;
}
module.exports = { ALLOWED_CHANNELS, trustedSender };
