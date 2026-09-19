import { existsSync } from "node:fs";

/** External Node processes cannot read Electron's virtual ASAR filesystem. */
export function resolveSkillsCliPath(resolvedPath: string): string {
  const executablePath = resolvedPath.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
  if (!existsSync(executablePath)) {
    throw new Error("The bundled skills CLI is unavailable. Reinstall Pi Studio or its dependencies.");
  }
  return executablePath;
}
