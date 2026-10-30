import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { tmpdir } from "node:os";

export function desktopTestDirectory(args: string[], environment: NodeJS.ProcessEnv) {
  const argument = args.find(value => value.startsWith("--claudio-test-data="));
  if (!argument) return undefined;
  if (environment.CLAUDIO_DESKTOP_TEST !== "1") throw new Error("Desktop test mode not enabled");
  const directory = realpathSync(argument.slice("--claudio-test-data=".length));
  if (dirname(directory) !== realpathSync(tmpdir()) || !basename(directory).startsWith("claudio-desktop-test-")) {
    throw new Error("Desktop tests require an isolated temporary directory");
  }
  return directory;
}
