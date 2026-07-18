const path = require('node:path');

const PACKAGED_TRAY_ICON_NAME = 'tray-icon.png';

function resolveTrayIconPath({ isPackaged, appPath, resourcesPath }) {
  if (isPackaged) return path.join(resourcesPath, PACKAGED_TRAY_ICON_NAME);
  return path.join(appPath, 'build', 'icon.png');
}

module.exports = {
  PACKAGED_TRAY_ICON_NAME,
  resolveTrayIconPath,
};
