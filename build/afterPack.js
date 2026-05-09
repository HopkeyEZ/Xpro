const path = require('path');
const { rcedit } = require('rcedit');

exports.default = async function afterPack(context) {
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const iconPath = path.join(__dirname, 'icon.ico');

  console.log(`[afterPack] Embedding icon into ${exePath}`);
  try {
    await rcedit(exePath, { icon: iconPath });
    console.log('[afterPack] Icon embedded successfully');
  } catch (err) {
    console.error('[afterPack] Failed to embed icon:', err.message);
  }
};
