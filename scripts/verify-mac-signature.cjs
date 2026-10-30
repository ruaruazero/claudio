const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

module.exports = async function verifyMacSignature(context) {
  if (context.electronPlatformName !== "darwin") return;
  const application = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", application], {
    stdio: "inherit",
  });
};
