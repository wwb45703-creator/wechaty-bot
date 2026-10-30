const path = require('node:path');

const output = path.resolve(process.env.BOT_INSTALLER_OUTPUT || 'E:\\微信机器人安装包\\2026-10-30');
const resources = path.resolve(process.env.BOT_INSTALLER_STAGE || path.join(output, '.stage', 'resources'));

module.exports = {
  extends: null,
  appId: 'com.wwb.wechaty-bot-console',
  productName: '微信机器人控制台',
  extraMetadata: {
    version: '1.2.0',
    description: '微信群聊社交成长机器人本地控制台',
    author: 'Wechaty Bot Project',
  },
  directories: { output: path.join(output, 'build'), buildResources: path.join(__dirname, 'build') },
  asar: true,
  compression: 'normal',
  npmRebuild: false,
  files: [
    'main.js', 'ipc-policy.js', 'preload.js', 'deployment-paths.cjs',
    'renderer/app.js', 'renderer/index.html', 'renderer/style.css',
  ],
  extraResources: [
    { from: path.join(resources, 'bot-runtime'), to: 'bot-runtime', filter: ['**/*', '!**/.mimosa/**', '!**/.git/**'] },
    { from: path.join(resources, 'prerequisites'), to: 'prerequisites' },
  ],
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: path.join(__dirname, 'build', 'icon.ico') },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    allowElevation: false,
    selectPerMachineByDefault: false,
    packElevateHelper: false,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '微信机器人控制台 1.2',
    unicode: true,
    installerLanguages: ['zh_CN'],
    differentialPackage: false,
    // The default separate pre-compressed pass skips node_modules entirely.
    // Keep its runtime/fixture media inside the main archive, too.
    preCompressedFileExtensions: [],
    include: path.join(__dirname, 'build', 'installer.nsh'),
    artifactName: 'WechatyBotConsole-Setup-${version}-${arch}.${ext}',
  },
};
