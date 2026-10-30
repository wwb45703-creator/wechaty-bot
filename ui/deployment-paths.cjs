const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function resolveDeployment({ env = process.env, resourcesPath = '', fileSystem = fs } = {}) {
  const bundledRoot = path.join(resourcesPath, 'bot-runtime');
  let installed = false;
  try {
    const marker = JSON.parse(fileSystem.readFileSync(path.join(bundledRoot, 'distribution.json'), 'utf8'));
    installed = marker.format === 1 && marker.kind === 'wechaty-bot-offline';
  } catch {}
  const projectRoot = path.resolve(env.BOT_PROJECT_ROOT || (installed ? bundledRoot : 'D:\\wechaty-bot'));
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dataRoot = path.resolve(env.BOT_DATA_ROOT || (installed ? path.join(localAppData, 'WechatyBotConsole', 'data') : projectRoot));
  return {
    installed, projectRoot, dataRoot,
    configFile: path.resolve(env.BOT_CONFIG_FILE || path.join(dataRoot, 'config.json')),
    ollamaExe: env.BOT_OLLAMA_EXE || (installed ? path.join(projectRoot, 'runtime', 'ollama', 'ollama.exe') : 'D:\\Ollama\\ollama.exe'),
  };
}

function initializeInstalledData(deployment) {
  if (!deployment.installed) return;
  for (const name of ['logs', 'state']) fs.mkdirSync(path.join(deployment.dataRoot, name), { recursive: true });
  fs.mkdirSync(path.dirname(deployment.configFile), { recursive: true });
  try {
    fs.copyFileSync(path.join(deployment.projectRoot, 'config.defaults.json'), deployment.configFile, fs.constants.COPYFILE_EXCL);
    for (const name of ['bot-disabled.flag', 'ollama-disabled.flag']) {
      try { fs.writeFileSync(path.join(deployment.dataRoot, 'state', name), '', { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
}

module.exports = { resolveDeployment, initializeInstalledData };
